import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createHash, randomUUID } from 'node:crypto'
import { SessionId, interruptedTurnClosers, snapshotSessionEvent, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { foldSubagentDescriptor, resolveChildDepth, snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import type { ResearchSessionBatch, ResearchSessionBootstrap } from './protocol.js'

/** Append preserves source seqs/references/payloads; the public API stamps host receipt time. */
function append(session: Session, event: SessionEvent): SessionEvent {
  const opts = {
    ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
    ...(event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs }),
  }
  return (session.append as (type: SessionEvent['type'], data: SessionEvent['data'], opts: object) => SessionEvent)(event.type, event.data, opts)
}

/** A display-only Session, never an Agent. Missing display infrastructure is optional. */
export function createResearchSessionMirror(ctx: Context, parent: Agent) {
  const sessions = ctx.reflect.get('sessions') as Context['sessions'] | undefined
  if (!sessions || !ctx.reflect.get('sessionProjections')) return undefined
  const bootstrap: ResearchSessionBootstrap = {
    id: `research-${randomUUID()}`, parentId: parent.session.id,
    descriptor: snapshotSubagentDescriptor({ mode: 'one-shot', provider: 'search-enhance-research-sdk', label: 'web_research' }),
  }
  const persistence = ctx.reflect.get('sessionPersistence') as Context['sessionPersistence'] | undefined
  let session: Session | undefined
  let writer: SessionHandle | undefined
  let detach: (() => void) | undefined
  let remoteId: string | undefined
  let createdAt: number | undefined
  let pending: SessionEvent[] = []
  let tail: SessionEvent[] = []
  const hashes: string[] = []
  let chain = Promise.resolve()
  let fault: unknown
  let closed = false
  let closing: Promise<void> | undefined
  let released = false
  const release = ctx.effect(() => () => { released = true; if (closed) { detach?.(); detach = undefined } })
  const remember = (event: SessionEvent) => {
    if (event.type === 'turn/start') tail = []
    tail.push(event)
    if (event.type === 'turn/end') tail = []
  }
  const receive = async (packet: ResearchSessionBatch) => {
    if (closed || fault) throw new Error('Research observation channel closed')
    if (packet.id !== bootstrap.id || packet.parentId !== bootstrap.parentId || typeof packet.remoteId !== 'string' || !packet.remoteId || !Number.isSafeInteger(packet.createdAt) || packet.createdAt < 0 || !Array.isArray(packet.events)) throw new Error('Invalid research observation identity')
    if (remoteId !== undefined && (remoteId !== packet.remoteId || createdAt !== packet.createdAt)) throw new Error('Research observation identity changed')
    remoteId = packet.remoteId
    createdAt = packet.createdAt
    for (const raw of packet.events) {
      const event = snapshotSessionEvent(raw)
      const hash = createHash('sha256').update(JSON.stringify(event)).digest('hex')
      if (event.seq < hashes.length) {
        if (hashes[event.seq] !== hash) throw new Error('Conflicting research observation retry')
        continue
      }
      if (event.seq !== hashes.length) throw new Error('Research observation sequence gap')
      if (!session) {
        pending.push(event)
        if (event.type === 'subagent/descriptor') {
          const descriptor = foldSubagentDescriptor(pending)
          if (JSON.stringify(descriptor) !== JSON.stringify(bootstrap.descriptor) || !pending.some(item => item.type === 'turn/start')) throw new Error('Invalid research observation descriptor')
          // Validate before creating durable/public identity; no catalog for failed setup.
          session = sessions.prepare(SessionId(bootstrap.id), { meta: {
            cwd: parent.session.header.cwd ?? process.cwd(), parentSession: parent.session.id,
            createdAt, origin: 'subagent', isSeeded: false,
            delegationDepth: resolveChildDepth(parent, undefined),
          } })
          writer = await persistence?.create(session.header)
          detach = sessions.enter(session)
          sessions.announce(session)
          for (const item of pending) remember(append(session, item))
          pending = []
          // Identity and its initial prefix are readable before the parent's catalog announces it.
          await sessions.flush(session)
          parent.session.append('subagent/catalog', { version: 0, childId: session.id, childCreatedAt: session.header.createdAt, mode: 'one-shot', label: bootstrap.descriptor.label! })
          await sessions.flush(parent.session)
        }
      } else remember(append(session, event))
      hashes.push(hash)
    }
  }
  return {
    bootstrap,
    accept(packet: ResearchSessionBatch): Promise<void> {
      if (closing) return Promise.reject(new Error('Research observation channel closed'))
      const work = chain.then(() => receive(packet))
      chain = work.catch(error => { fault ??= error })
      return work
    },
    close(): Promise<void> {
      return closing ??= (async () => {
        await chain
        closed = true
        try {
          if (session && detach) {
            // Official repair describes interrupted/unknown outcomes, never a successful completion.
            for (const event of interruptedTurnClosers(tail)) append(session, event)
            await sessions.flush(session)
          }
        } finally {
          try { await writer?.close() }
          finally {
            if (persistence || released) { detach?.(); detach = undefined }
            if (persistence) await release()
            // Otherwise the owner effect retains memory-only history until plugin disposal.
          }
        }
        if (fault) ctx.logger.warn('web_research: observation interrupted; retained the readable prefix')
      })()
    },
  }
}
