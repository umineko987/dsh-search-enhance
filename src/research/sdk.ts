import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import * as sdkBackend from '@deepseek-ai/dsh-subagent-dsh-sdk'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import { randomUUID } from 'node:crypto'
import { prepareResearchProfile } from './profile.js'
import { createResearchBridge } from './bridge.js'
import type { ResearchBootstrap } from './protocol.js'
import { createResearchSessionMirror } from './session-mirror.js'

export interface SdkResearchRequest {
  parent: Agent
  query: string
  route: AgentOptions & { provider?: string; model?: string }
  bootstrap: ResearchBootstrap
  auth: () => Promise<Record<string, string>>
  signal: AbortSignal
  callerSignal: AbortSignal
}

/** Official backend owns the agent loop, SDK transport and subprocess reaping. */
export async function startSdkResearch(ctx: Context, request: SdkResearchRequest) {
  request.signal.throwIfAborted()
  const profile = await prepareResearchProfile()
  const mirror = createResearchSessionMirror(ctx, request.parent)
  let bridge: Awaited<ReturnType<typeof createResearchBridge>> | undefined
  let backend: ReturnType<Context['plugin']> | undefined
  let run: SubagentRun | undefined
  let disposal: Promise<void> | undefined
  const dispose = () => disposal ??= (async () => {
    try { await run?.dispose() }
    finally {
      try { await backend?.dispose() }
      finally {
        try { await mirror?.close() }
        catch {
          // Optional display persistence must not replace an accepted report or cancellation.
          ctx.logger.warn('web_research: display history cleanup failed; persisted history may be incomplete')
        }
        finally { try { await bridge?.dispose() } finally { await profile.dispose() } }
      }
    }
  })()
  try {
    request.signal.throwIfAborted()
    const bootstrap = { ...request.bootstrap, ...(mirror ? { session: mirror.bootstrap } : {}) }
    bridge = await createResearchBridge(ctx, bootstrap, request.auth, request.callerSignal, mirror, request.signal)
    const providerName = `search-enhance-research-${randomUUID()}`
    backend = ctx.plugin(sdkBackend, {
      providerName, profile: profile.profile, dshHome: profile.home, patches: [],
      // The execution directory is also isolated: the CLI never reads a user's .env.
      cwd: profile.home, provider: request.route.provider!, model: request.route.model!,
      env: { ...bridge.env, NODE_OPTIONS: '', NODE_PATH: '', DSH_TELEMETRY: 'false' },
    })
    await backend.await()
    request.signal.throwIfAborted()
    run = await ctx.subagents.start(providerName, {
      parent: request.parent, prompt: [{ type: 'text', text: request.query }],
      agentOptions: request.route, signal: request.signal,
    })
    return { run, bridge, home: profile.home, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
