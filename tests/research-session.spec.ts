import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createResearchSessionMirror } from '../src/research/session-mirror.js'
import { observeResearchSession } from '../src/research/session-observer.js'
import { createResearchBridge } from '../src/research/bridge.js'
import type { ResearchBootstrap, ResearchSessionBatch } from '../src/research/protocol.js'
import { Config } from '../src/config.js'

class ReadOnlySessionQuery extends SessionQuery {
  override searchSessions(): never { throw new Error('Not used by this fixture') }
  override searchEvents(): never { throw new Error('Not used by this fixture') }
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function harness(persistent = false, runtimeDepth = 0) {
  const ctx = new Context()
  new SessionProjectionRegistry(ctx)
  new SessionStore(ctx)
  new ReadOnlySessionQuery(ctx)
  new SubagentRuntime(ctx, { maxDepth: { get: () => 4 }, maxActiveSubagents: { get: () => 4 } })
  const root = await mkdtemp(join(tmpdir(), 'research-mirror-unit-'))
  if (persistent) new Persistence(ctx, { root, compression: 'none' })
  const parentSession = ctx.sessions.create(SessionId('parent'), { meta: { cwd: root, delegationDepth: 2 } })
  const parentWriter = persistent ? await ctx.sessionPersistence.create(parentSession.header) : undefined
  parentSession.append('turn/start', { turn: 1 })
  const parent = { session: parentSession, options: { subagentDepth: runtimeDepth } } as Agent
  let mirror!: NonNullable<ReturnType<typeof createResearchSessionMirror>>
  const owner = ctx.plugin({ name: 'mirror-test-owner', apply(scope: Context) { mirror = createResearchSessionMirror(scope, parent)! } })
  await owner.await()
  cleanup.push(async () => { await mirror.close(); await owner.dispose(); await parentWriter?.close(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const source = Session.create(SessionId('remote'))
  source.append('turn/start', { turn: 1 })
  source.append('subagent/descriptor', mirror.bootstrap.descriptor)
  source.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'fixture research' }], source: { kind: 'user' } }), { surfaceOp: 'append', sourceEventSeqs: [SessionSeq(0)] })
  source.append('step/start', { turn: 1, step: 1 })
  source.append('assistant/message', { turn: 1, step: 1, stream: [], message: { id: MessageId('assistant-fixture'), role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content: [{ type: 'tool-call', id: ToolCallId('search-call'), name: 'web_search', arguments: '{"query":"fixture"}' }] } }, { surfaceOp: 'append' })
  source.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('search-call'), name: 'web_search', arguments: '{"query":"fixture"}' })
  const events = source.snapshotEvents()
  const packet = (items: readonly SessionEvent[] = events): ResearchSessionBatch => ({ id: mirror.bootstrap.id, parentId: mirror.bootstrap.parentId, remoteId: source.id, createdAt: source.header.createdAt, events: items })
  return { ctx, owner, parentSession, mirror, source, events, packet }
}

describe('research display-only session protocol', () => {
  it.each([1, 5])('keeps monotone delegation depth when the caller runtime depth is %s', async runtimeDepth => {
    const h = await harness(true, runtimeDepth)
    await h.mirror.accept(h.packet())
    const record = await h.ctx.sessionQuery.readSession(SessionId(h.mirror.bootstrap.id))
    expect(record.session.delegationDepth).toBe(Math.max(2, runtimeDepth) + 1)
  })
  it('waits for real initial descriptor, deduplicates retries, serializes packets and repairs an interrupted tool tail', async () => {
    const h = await harness(true)
    await h.mirror.accept(h.packet(h.events.slice(0, 1)))
    expect(await h.ctx.subagents.listChildren(h.parentSession.id)).toEqual([])
    await Promise.all([h.mirror.accept(h.packet(h.events.slice(1, 3))), h.mirror.accept(h.packet(h.events.slice(3)))])
    await h.mirror.accept(h.packet())
    const listed = await h.ctx.subagents.listChildren(h.parentSession.id)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ id: h.mirror.bootstrap.id, label: 'web_research', mode: 'one-shot' })
    const live = await h.ctx.sessionQuery.readSession(SessionId(h.mirror.bootstrap.id))
    expect(live.events).toHaveLength(h.events.length)
    expect(live.events.map(event => event.data)).toEqual(h.events.map(event => event.data))
    const references = (events: readonly SessionEvent[]) => events.map(({ seq, surfaceOp, sourceEventSeqs }) => ({ seq, surfaceOp, sourceEventSeqs }))
    expect(references(live.events)).toEqual(references(h.events))
    expect(live.session).toMatchObject({ origin: 'subagent', isSeeded: false, parentSession: h.parentSession.id, delegationDepth: 3 })
    await Promise.all([h.mirror.close(), h.mirror.close()])
    const cold = await h.ctx.sessionQuery.readSession(SessionId(h.mirror.bootstrap.id))
    expect(cold.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'interrupted' } } })
    expect(cold.events.find(event => event.type === 'tool/result')).toMatchObject({ data: { error: { code: 'TOOL_OUTCOME_UNKNOWN' }, message: { isError: true, toolCallId: 'search-call', source: { callId: 'search-call' } } } })
    expect(cold.events.every((event, index) => event.seq === index)).toBe(true)
    expect(h.ctx.sessions.get(SessionId(h.mirror.bootstrap.id))).toBeUndefined()
    await expect(h.mirror.accept(h.packet())).rejects.toThrow(/closed/)
  })
  it.each(['gap', 'conflict', 'identity'] as const)('fails closed on %s without losing the readable prefix', async kind => {
    const h = await harness(true)
    await h.mirror.accept(h.packet())
    const invalid = kind === 'gap' ? h.packet([{ ...h.events[0]!, seq: h.events.length + 1 } as SessionEvent])
      : kind === 'conflict' ? h.packet([{ ...h.events[0]!, time: h.events[0]!.time + 1 }])
      : { ...h.packet(), remoteId: 'another-child' }
    await expect(h.mirror.accept(invalid)).rejects.toThrow(/gap|retry|identity/)
    await h.mirror.close()
    expect((await h.ctx.sessionQuery.readSession(SessionId(h.mirror.bootstrap.id))).events.at(-1)).toMatchObject({ data: { reason: { kind: 'interrupted' } } })
  })
  it.each(['id', 'parentId', 'descriptor'] as const)('does not publish a catalog for invalid initial %s', async kind => {
    const h = await harness()
    const packet = kind === 'descriptor' ? h.packet(h.events.map(event => event.type === 'subagent/descriptor' ? { ...event, data: { ...h.mirror.bootstrap.descriptor, mode: 'continuable' } } as SessionEvent : event)) : { ...h.packet(), [kind]: 'wrong' }
    await expect(h.mirror.accept(packet)).rejects.toThrow()
    expect(await h.ctx.subagents.listChildren(h.parentSession.id)).toEqual([])
    expect(h.ctx.sessions.get(SessionId(h.mirror.bootstrap.id))).toBeUndefined()
  })
  it('retains memory-only history until its plugin owner is disposed', async () => {
    const h = await harness()
    await h.mirror.accept(h.packet())
    await h.mirror.close()
    expect(h.ctx.sessions.get(SessionId(h.mirror.bootstrap.id))).toBeDefined()
    await h.owner.dispose()
    expect(h.ctx.sessions.get(SessionId(h.mirror.bootstrap.id))).toBeUndefined()
  })
  it('drains and closes its persistent writer after the owning plugin has been disposed', async () => {
    const h = await harness(true)
    await h.mirror.accept(h.packet())
    await h.owner.dispose()
    expect(h.ctx.sessions.get(SessionId(h.mirror.bootstrap.id))).toBeDefined()
    await h.mirror.close()
    expect(h.ctx.sessions.get(SessionId(h.mirror.bootstrap.id))).toBeUndefined()
    expect((await h.ctx.sessionQuery.readSession(SessionId(h.mirror.bootstrap.id))).events.at(-1)).toMatchObject({ data: { reason: { kind: 'interrupted' } } })
  })
  it('does not require any display services in headless composition', async () => {
    const ctx = new Context()
    expect(createResearchSessionMirror(ctx, {} as Agent)).toBeUndefined()
    const send = vi.fn()
    await observeResearchSession(ctx, undefined, send).drain()
    expect(send).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
  it('observer retries identical committed batches, ignores other sessions, and stops updates explicitly on transport failure', async () => {
    const h = await harness()
    const send = vi.fn().mockRejectedValue(new Error('offline'))
    const observer = observeResearchSession(h.ctx, h.mirror.bootstrap, send)
    const remote = h.ctx.sessions.create(SessionId('observed'))
    remote.append('turn/start', { turn: 1 })
    await observer.drain()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0]![0]).toEqual(send.mock.calls[1]![0])
    remote.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'fixture failure' } } })
    h.ctx.sessions.create(SessionId('unrelated')).append('turn/start', { turn: 1 })
    await observer.drain()
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('allows observation/finished drain after cancellation but refuses credentials, auth and reports', async () => {
    const h = await harness(true)
    const caller = new AbortController(), work = new AbortController()
    const bootstrap: ResearchBootstrap = { config: Config({} as never), model: { provider: 'deepseek-official', connection: {} as never }, timeoutMs: 60000, finishMs: 12000, softDeadline: Date.now() + 48000, hardDeadline: Date.now() + 60000 }
    const auth = vi.fn(async () => ({ 'x-api-key': 'fixture' }))
    const bridge = await createResearchBridge(h.ctx, bootstrap, auth, caller.signal, h.mirror, work.signal)
    cleanup.push(bridge.dispose)
    const call = async (path: string, payload?: unknown, token = bridge.env.DSH_RESEARCH_TOKEN) => fetch(`${bridge.env.DSH_RESEARCH_CHANNEL}${path}`, { method: payload === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) })
    expect((await call('/session-events', h.packet(), 'wrong-token')).status).toBe(403)
    work.abort(new Error('hard budget'))
    expect((await call('/model-auth')).status).toBe(400)
    expect(auth).not.toHaveBeenCalled()
    caller.abort(new Error('caller cancel'))
    expect((await call('/bootstrap')).status).toBe(400)
    expect((await call('/credential/DEEPSEEK_API_KEY')).status).toBe(400)
    expect((await call('/report', { acceptedAt: Date.now(), report: { conclusions: [], limitations: ['fixture'], stop_reason: 'completed' } })).status).toBe(400)
    expect(bridge.report()).toBeUndefined()
    expect((await call('/session-events', h.packet())).status).toBe(200)
    expect((await call('/finished', {})).status).toBe(200)
    await bridge.finished
    await h.mirror.close()
    expect((await h.ctx.subagents.listChildren(h.parentSession.id))).toHaveLength(1)
  })
})
