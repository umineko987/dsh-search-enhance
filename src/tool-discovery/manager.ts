import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { ToolDiscoveryMode } from '../config.js'
import { CAPABILITY_GROUPS, type CapabilityGroup } from './capabilities.js'
import {
  foldToolDisclosureEvent,
  foldToolDisclosureEvents,
  type ToolDisclosureFoldState,
} from './fold.js'

export interface AgentToolDisclosureManagerOptions {
  readonly mode: ToolDiscoveryMode
  readonly webSearchDefinition: ToolDefinition
  readonly deferredTools: Readonly<Record<CapabilityGroup, ToolDefinition>>
}

interface AgentToolState {
  readonly agent: Agent
  readonly disposers: Map<CapabilityGroup, () => void>
  disposeWebSearchShadow?: () => void
  fold: ToolDisclosureFoldState
}

/** Own Agent-scoped real tools; loading is committed only at a completed step boundary. */
export class AgentToolDisclosureManager {
  private readonly bySession = new Map<Session, AgentToolState>()

  constructor(private readonly options: AgentToolDisclosureManagerOptions) {}

  attach(agent: Agent): void {
    const existing = this.bySession.get(agent.session)
    if (existing?.agent === agent) return
    if (existing !== undefined) throw new Error(`session ${agent.session.id} already has a live Agent`)
    const state: AgentToolState = {
      agent,
      disposers: new Map(),
      fold: foldToolDisclosureEvents(agent.session.snapshotEvents()),
    }
    this.bySession.set(agent.session, state)
    try {
      // Preserve the host's decision to expose web_search before installing the rich shadow.
      if (agent.ctx.tools.get('web_search', agent) !== undefined) {
        state.disposeWebSearchShadow = agent.ctx.tools.register(this.options.webSearchDefinition)
      }
      this.registerLoadedTools(state)
    } catch (error) {
      this.detach(agent)
      throw error
    }
  }

  activeGroups(agent: Agent): readonly CapabilityGroup[] {
    const state = this.bySession.get(agent.session)
    if (state?.agent !== agent) throw new Error('search_tools requires an attached live Agent')
    return CAPABILITY_GROUPS.filter(group => state.disposers.has(group))
  }

  private registerLoadedTools(state: AgentToolState): void {
    const groups = this.options.mode === 'all' ? CAPABILITY_GROUPS : state.fold.activeGroups
    for (const group of groups) {
      if (state.disposers.has(group)) continue
      state.disposers.set(group, state.agent.ctx.tools.register(this.options.deferredTools[group]))
    }
  }

  observeSession(session: Session, event: SessionEvent): void {
    const state = this.bySession.get(session)
    if (state === undefined) return
    state.fold = foldToolDisclosureEvent(state.fold, event)
    if (event.type === 'step/end') this.registerLoadedTools(state)
  }

  detach(agent: Agent): void {
    const state = this.bySession.get(agent.session)
    if (state?.agent !== agent) return
    this.bySession.delete(agent.session)
    for (const dispose of state.disposers.values()) dispose()
    state.disposeWebSearchShadow?.()
  }

  dispose(): void {
    for (const { agent } of [...this.bySession.values()]) this.detach(agent)
  }
}

export function installAgentToolDisclosure(
  ctx: Context,
  options: AgentToolDisclosureManagerOptions,
): AgentToolDisclosureManager {
  const manager = new AgentToolDisclosureManager(options)
  ctx.effect(() => () => manager.dispose())
  ctx.on('agent/created', ({ agent }) => { manager.attach(agent); return undefined })
  ctx.on('agent/disposed', ({ agent }) => manager.detach(agent))
  ctx.on('session/event', (session, event) => manager.observeSession(session, event))
  for (const agent of ctx.agents.list()) manager.attach(agent)
  return manager
}
