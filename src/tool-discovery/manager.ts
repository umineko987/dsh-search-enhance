import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolDefinition, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

import type { ToolDiscoveryMode } from '../config.js'
import type { SourceCallIdentity } from '../contracts/index.js'
import { isSourceRef } from '../source-storage/refs.js'
import { CAPABILITY_GROUPS, CAPABILITY_TOOL_NAMES, isSourceResultTool, type CapabilityGroup } from './capabilities.js'
import {
  foldToolDisclosureEvent,
  foldToolDisclosureEvents,
  type ToolDisclosureFoldState,
} from './fold.js'

export interface AgentToolDisclosureManagerOptions {
  readonly mode: ToolDiscoveryMode
  readonly webSearchDefinition: ToolDefinition
  readonly residentTools: Readonly<Record<'docs_search' | 'web_extract' | 'web_research', ToolDefinition>>
  readonly deferredTools: Readonly<Record<CapabilityGroup, ToolDefinition>>
  readonly canReadSourceRef: (agent: Agent, ref: string) => boolean
  /** Synchronous, unambiguous private-store lookup by the complete trusted call identity; never parse model text. */
  readonly sourceRefForCall: (agent: Agent, call: SourceCallIdentity) => string | undefined
}

interface AgentToolState {
  readonly agent: Agent
  readonly disposers: Map<string, () => void>
  readonly observedSources: Map<string, string>
  readonly hostWebSearchAllowed: boolean
  disposeRestriction?: () => void
  fold: ToolDisclosureFoldState
}


function callKey(call: SourceCallIdentity): string {
  return JSON.stringify([call.mode, call.rootCallId, call.callId, call.name])
}

/** Own role-appropriate Agent-scoped tools; automatic pagination commits at a completed step boundary. */
export class AgentToolDisclosureManager {
  private readonly bySession = new Map<Session, AgentToolState>()

  constructor(private readonly options: AgentToolDisclosureManagerOptions) {}

  attach(agent: Agent): void {
    const existing = this.bySession.get(agent.session)
    if (existing?.agent === agent) return
    if (existing !== undefined) throw new Error(`session ${agent.session.id} already has a live Agent`)
    const fold = foldToolDisclosureEvents(agent.session.snapshotEvents(), call => {
      const ref = this.options.sourceRefForCall(agent, call)
      return isSourceRef(ref) && this.options.canReadSourceRef(agent, ref)
    })
    const state: AgentToolState = {
      agent, fold,
      disposers: new Map(),
      observedSources: new Map(),
      hostWebSearchAllowed: agent.ctx.tools.get('web_search', agent) !== undefined,
    }
    for (const call of fold.pendingSources) {
      const ref = this.options.sourceRefForCall(agent, call)
      if (isSourceRef(ref)) state.observedSources.set(callKey(call), ref)
    }
    this.bySession.set(agent.session, state)
    try {
      this.configureRole(state)
    } catch (error) {
      this.detach(agent)
      throw error
    }
  }


  activeGroups(agent: Agent): readonly CapabilityGroup[] {
    const state = this.bySession.get(agent.session)
    if (state?.agent !== agent) throw new Error('tool disclosure requires an attached live Agent')
    return CAPABILITY_GROUPS.filter(group => state.disposers.has(CAPABILITY_TOOL_NAMES[group]))
  }

  private register(state: AgentToolState, definition: ToolDefinition): void {
    if (state.disposers.has(definition.name)) return
    state.disposers.set(definition.name, state.agent.ctx.tools.register(definition))
  }

  private configureRole(state: AgentToolState): void {
    state.disposeRestriction?.()
    delete state.disposeRestriction
    if (state.hostWebSearchAllowed) this.register(state, this.options.webSearchDefinition)
    this.register(state, this.options.residentTools.docs_search)
    this.register(state, this.options.residentTools.web_extract)
    this.register(state, this.options.residentTools.web_research)
    this.registerLoadedTools(state)
  }

  private restrictInheritedTools(state: AgentToolState): void {
    state.disposeRestriction?.()
    delete state.disposeRestriction
    // DSH rejects restrictions naming unknown or scope-local tools: mask only inherited names.
    const denied = ['web_map', 'search_tools', 'search_sources']
      .filter(name => !state.disposers.has(name) && state.agent.ctx.tools.get(name, state.agent) !== undefined)
    if (denied.length > 0) state.disposeRestriction = state.agent.ctx.tools.restrict({ deny: denied })
  }

  private registerLoadedTools(state: AgentToolState): void {
    const groups: readonly CapabilityGroup[] = this.options.mode === 'all' ? ['sources'] : state.fold.activeGroups
    for (const group of groups) {
      if (group === 'site_map') continue
      this.register(state, this.options.deferredTools[group])
    }
    // Ancestor registrations may appear later; keep ordinary descendants isolated too.
    for (const current of this.bySession.values()) this.restrictInheritedTools(current)
  }

  observeToolResult(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): void {
    if (exec.agent === undefined || result.isError || !isSourceResultTool(exec.name)) return
    const state = this.bySession.get(exec.agent.session)
    if (state?.agent !== exec.agent || state.fold.step === undefined) return
    const value = result.value
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return
    const ref = value.source_ref
    if (!isSourceRef(ref) || !this.options.canReadSourceRef(exec.agent, ref)) return
    const call: SourceCallIdentity = {
      mode: exec.parent === undefined ? 'top-level' : 'nested-code',
      callId: exec.callId, rootCallId: exec.rootCallId, name: exec.name,
    }
    if (this.options.sourceRefForCall(exec.agent, call) !== ref) return
    state.observedSources.set(callKey(call), ref)
  }

  observeSession(session: Session, event: SessionEvent): void {
    const state = this.bySession.get(session)
    if (state === undefined) return
    if (event.type === 'step/start') state.observedSources.clear()
    state.fold = foldToolDisclosureEvent(state.fold, event, call => {
      const ref = state.observedSources.get(callKey(call))
      return ref !== undefined && this.options.canReadSourceRef(state.agent, ref)
    })
    if (event.type === 'step/end') this.registerLoadedTools(state)
    if ((event.type === 'step/end' && state.fold.step === undefined) || event.type === 'turn/end') state.observedSources.clear()
  }

  detach(agent: Agent): void {
    const state = this.bySession.get(agent.session)
    if (state?.agent !== agent) return
    this.bySession.delete(agent.session)
    for (const dispose of state.disposers.values()) dispose()
    state.disposeRestriction?.()
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
  ctx.on('tools/result', (exec, result) => { manager.observeToolResult(exec, result); return undefined })
  ctx.on('session/event', (session, event) => manager.observeSession(session, event))
  for (const agent of ctx.agents.list()) manager.attach(agent)
  return manager
}
