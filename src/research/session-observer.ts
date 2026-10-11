import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ResearchSessionBootstrap } from './protocol.js'

/** Only committed events from the SDK's single research session; no token stream. */
export function observeResearchSession(ctx: Context, bootstrap: ResearchSessionBootstrap | undefined,
  send: (payload: unknown) => Promise<unknown>) {
  if (!bootstrap) return { drain: async () => {} }
  let session: Session | undefined
  let pending: SessionEvent[] = []
  let task: Promise<void> | undefined
  let failed = false
  const drain = (): Promise<void> => {
    if (task) return task
    task = Promise.resolve().then(async () => {
      while (pending.length && !failed) {
        const events = pending
        pending = []
        const packet = { id: bootstrap.id, parentId: bootstrap.parentId, remoteId: session!.id, createdAt: session!.header.createdAt, events }
        // A lost HTTP acknowledgement repeats the exact batch; host seq hashes deduplicate it.
        try { await send(packet) }
        catch { await send(packet) }
      }
    }).catch(() => {
      failed = true
      pending = []
      ctx.logger.warn('web_research: session observation unavailable; research continues without further display updates')
    }).finally(() => { task = undefined })
    return task
  }
  ctx.on('session/created', created => { session ??= created })
  ctx.on('session/event', (source, event) => {
    if (source !== session || failed) return
    pending.push(event)
    void drain()
  })
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session !== session) return
    let described = false
    agent.ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      if (!described && decision.kind === 'enter') {
        described = true
        agent.session.append('subagent/descriptor', bootstrap.descriptor)
      }
      // Step-boundary backpressure bounds the queue by one step, not the whole research.
      await drain()
      return decision
    })
    return undefined
  })
  return { drain }
}
