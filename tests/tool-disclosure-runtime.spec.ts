import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { PtcRuntime, type PtcRunRequest, type PtcRunResult, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createToolResultMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { KNOWN_SESSION_EVENT_TYPES, SessionId, SessionStore, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SystemPrompt, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool, type ToolDefinition, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SourceCallIdentity, SourceRef, StoredSourceRecord } from '../src/contracts/index.js'
import { SourceRecordStore, sourceCallIdentity } from '../src/source-storage/index.js'
import { RESIDENT_TOOL_NAMES, installAgentToolDisclosure, type AgentToolDisclosureManager } from '../src/tool-discovery/index.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

function textTool(name: string): ToolDefinition {
  return defineTool({
    name, description: `${name} test definition`, parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return name },
  })
}

function optionalTool(name: string): ToolDefinition {
  return defineTool({
    name, description: `${name} optional tool`, parameters: { value: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: `${name}:${value}` }] },
    async execute(args) { return args.value },
  })
}

function sourceTool(name: string, sources: SourceRecordStore): ToolDefinition {
  return defineTool({
    name, description: `${name} canonical source fixture`,
    parameters: { query: { type: 'string', required: true }, behavior: { type: 'string' }, source_ref: { type: 'string' } },
    output: {
      schema: { type: 'object', properties: { source_ref: { type: 'string' } }, additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.source_ref ?? 'source_ref: src_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }],
      presentationMeta: (_args, value) => ({ source_produced: value.source_ref !== undefined }),
    },
    async execute(args, exec) {
      if (args.behavior === 'fail') throw new Error('Search failed')
      if (args.behavior === 'none' || args.behavior === 'text') return {}
      if (args.behavior === 'invalid') return { source_ref: 'not-a-source-ref' }
      if (args.behavior === 'foreign') return { source_ref: args.source_ref! }
      const commit = await sources.record(exec.agent!.session, sourceCallIdentity(exec), {
        query: args.query, collectionTruncated: false,
        sources: [{ url: 'https://example.test/doc', provider: 'search-api' }],
      }, exec.signal)
      if (args.behavior === 'schema') return { source_ref: 42 } as never
      return { source_ref: String(commit.sourceRef) }
    },
  })
}

const BASE_WEB_SEARCH = textTool('web_search')

interface TestAgent {
  readonly agent: Agent
  readonly owner: ReturnType<Context['plugin']>
  readonly scope: Scope
  readonly session: Session
}

interface Harness {
  readonly ctx: Context
  readonly runtime: ToolRuntime
  readonly sources: SourceRecordStore
  readonly records: Map<SourceRef, StoredSourceRecord>
  readonly richSearch: ToolDefinition
  pluginFiber: ReturnType<Context['plugin']>
  manager: AgentToolDisclosureManager
  denyReads: boolean
}

/** Exercises the real run_code bridge and SDK bindings; fixture programs are controlled by these tests. */
class BindingPtcRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'test'
  resolve(request: PtcRunRequest): PtcRunSpec { return { ...request, cwd: process.cwd(), timeoutMs: null } }
  async run(spec: PtcRunSpec): Promise<PtcRunResult> {
    const functions = spec.bindings.find(binding => binding.global === 'tools')!.functions
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
    try { return { value: await new AsyncFunction('tools', spec.program)(functions), logs: [] } }
    catch (error) { return { error: { kind: 'exception', message: String(error) }, logs: [] } }
  }
}

async function createHarness(mode: 'native' | 'ptc' = 'native', discovery: 'progressive' | 'all' = 'progressive', baseSearch = true): Promise<Harness> {
  const ctx = new Context()
  new SessionStore(ctx)
  new AgentRegistry(ctx)
  new SystemPrompt(ctx, {})
  if (mode === 'ptc') new BindingPtcRuntime(ctx)
  const runtime = new ToolRuntime(ctx, { mode })
  const records = new Map<SourceRef, StoredSourceRecord>()
  const table: KvTable<SourceRef, StoredSourceRecord> = {
    get size() { return records.size },
    get: key => records.get(key), entries: () => records.entries(), keys: () => records.keys(),
    async put(key, value) { records.set(key, value) },
    async delete(key) { return records.delete(key) },
    async update(key, transform) { const value = transform(records.get(key)!); records.set(key, value); return value },
  }
  const sources = new SourceRecordStore(table, {
    maxBytes: 64 * 1024, maxRecords: 100, maxSources: 10,
    maxPageSize: 100, maxPageBytes: 64 * 1024, maxSnippetCharacters: 4000,
  })
  const baseFiber = ctx.plugin((pluginCtx: Context) => { if (baseSearch) pluginCtx.tools.register(BASE_WEB_SEARCH) })
  await baseFiber.await()
  const richSearch = sourceTool('web_search', sources)
  const harness = { ctx, runtime, sources, records, richSearch, denyReads: false } as Harness
  harness.pluginFiber = ctx.plugin((pluginCtx: Context) => {
    harness.manager = installAgentToolDisclosure(pluginCtx, {
      mode: discovery, webSearchDefinition: richSearch,
      residentTools: { docs_search: sourceTool('docs_search', sources), web_extract: textTool('web_extract'), web_research: sourceTool('web_research', sources) },
      deferredTools: { sources: optionalTool('search_sources'), site_map: optionalTool('web_map') },
      canReadSourceRef: (agent, ref) => !harness.denyReads && sources.lookup(agent.session, ref).state === 'found',
      // The production service will expose this synchronous full-identity lookup, reusing lookup() authorization.
      sourceRefForCall: (agent, call) => {
        const matches = [...records.values()].filter(record => sameCall(record.call, call)
          && sources.lookup(agent.session, record.sourceRef).state === 'found')
        return matches.length === 1 ? matches[0]!.sourceRef : undefined
      },
    })
  })
  await harness.pluginFiber.await()
  cleanup.push(async () => {
    await harness.pluginFiber.dispose()
    await baseFiber.dispose()
    sources.stop()
    await sources.drain()
    await ctx.fiber.dispose()
  })
  return harness
}

function sameCall(a: SourceCallIdentity, b: SourceCallIdentity): boolean {
  return a.mode === b.mode && a.rootCallId === b.rootCallId && a.callId === b.callId && a.name === b.name
}

async function createAgent(harness: Harness, id: string, options: {
  readonly events?: readonly SessionEvent[]; readonly parent?: ScopeKey; readonly session?: Session;
  readonly origin?: 'subagent'
} = {}): Promise<TestAgent> {
  const session = options.session ?? harness.ctx.sessions.create(SessionId(id), {
    ...(options.events === undefined ? {} : { seed: options.events }),
    ...(options.origin === undefined ? {} : { meta: { origin: options.origin } }),
  })
  const mutable = { id: session.id, options: {}, session, ctx: undefined } as unknown as Agent & { ctx: Context }
  const scope = createScope(harness.ctx, mutable, options.parent === undefined ? undefined : { parent: options.parent })
  mutable.ctx = scope.ctx
  const agent = mutable as Agent
  const owner = harness.ctx.plugin((pluginCtx: Context) => { pluginCtx.agents.register(agent) })
  await owner.await()
  const value = { agent, owner, scope, session }
  cleanup.push(async () => { await owner.dispose(); await scope.dispose() })
  return value
}

function execute(harness: Harness, agent: Agent, name: string, args: unknown, callId = ToolCallId(`${name}-${Math.random()}`)): Promise<ToolExecutionResult> {
  return harness.runtime.execute({ callId, name, arguments: args, agent, signal: new AbortController().signal })
}

async function search(harness: Harness, value: TestAgent, options: {
  readonly name?: string; readonly args?: Record<string, unknown>; readonly step?: number; readonly complete?: boolean;
  readonly resultCallId?: string; readonly program?: string
} = {}): Promise<ToolExecutionResult> {
  const step = options.step ?? 1
  value.session.append('step/start', { turn: 1, step })
  const name = options.program === undefined ? options.name ?? 'web_search' : 'run_code'
  const callId = ToolCallId(`call-${step}`)
  const args = options.program === undefined ? { query: 'source', ...options.args } : { code: options.program, description: 'Search fixture' }
  const call = value.session.append('tool/call', { turn: 1, step, callId, name, arguments: JSON.stringify(args) })
  const result = await execute(harness, value.agent, name, args, callId)
  value.session.append('tool/result', {
    turn: 1, step,
    message: createToolResultMessage({ callId: ToolCallId(options.resultCallId ?? callId), content: [...result.content], isError: result.isError }),
    ...(result.meta === undefined ? {} : { meta: result.meta }),
    ...(result.error?.info === undefined ? {} : { error: result.error.info }),
  }, { sourceEventSeqs: [call.seq], surfaceOp: 'append' })
  if (options.complete !== false) value.session.append('step/end', { turn: 1, step })
  return result
}

function names(harness: Harness, agent: Agent): string[] {
  return [...RESIDENT_TOOL_NAMES, 'search_sources', 'web_map', 'search_tools'].filter(name => harness.runtime.get(name, agent) !== undefined).sort()
}

function assembly(harness: Harness, agent: Agent) {
  return harness.ctx.systemPrompt.assemble({ scope: agent, agent })
}

const MAIN = [...RESIDENT_TOOL_NAMES].sort()

describe('role disclosure and automatic pagination with the real DSH runtime', () => {
  it('registers only the default main collection and the richer inherited web_search schema', async () => {
    const h = await createHarness()
    const a = await createAgent(h, 'main')
    expect(names(h, a.agent)).toEqual(MAIN)
    expect(h.runtime.schemas(a.agent).map(tool => tool.name).sort()).toEqual(MAIN)
    expect(h.runtime.get('web_search', a.agent)).toBe(h.richSearch)
    expect((await assembly(h, a.agent)).tools.map(tool => tool.name).sort()).toEqual(MAIN)
    expect((await execute(h, a.agent, 'web_search', {})).isError).toBe(true)
    expect((await execute(h, a.agent, 'web_map', { value: 'not exposed' })).isError).toBe(true)
    expect((await execute(h, a.agent, 'search_tools', { capabilities: ['sources'] })).isError).toBe(true)
  })

  it.each([false, true])('respects absent or filtered host web_search (filtered=%s)', async filtered => {
    const h = await createHarness('native', 'progressive', filtered)
    const parent: ScopeKey = {}
    const preset = createScope(h.ctx, parent)
    cleanup.push(() => preset.dispose())
    if (filtered) preset.ctx.tools.restrict({ deny: ['web_search'] })
    const a = await createAgent(h, 'restricted', { parent })
    expect(names(h, a.agent)).toEqual(MAIN.filter(name => name !== 'web_search'))
    expect(h.runtime.get('web_search', a.agent)).toBeUndefined()
  })

  it.each(['web_search', 'docs_search', 'web_research'])('enables pagination only after successful readable %s and leaves other Agents unchanged', async name => {
    const h = await createHarness()
    const a = await createAgent(h, 'searching')
    const b = await createAgent(h, 'other')
    expect((await search(h, a, { name, complete: false })).isError).toBe(false)
    expect(names(h, a.agent)).toEqual(MAIN)
    expect((await execute(h, a.agent, 'search_sources', { value: 'same step' })).isError).toBe(true)
    a.session.append('step/end', { turn: 1, step: 1 })
    expect(names(h, a.agent)).toEqual([...MAIN, 'search_sources'].sort())
    expect(names(h, b.agent)).toEqual(MAIN)
    expect(await execute(h, a.agent, 'search_sources', { value: 'next step' })).toMatchObject({ isError: false, value: 'next step' })
    expect((await execute(h, a.agent, 'search_sources', {})).isError).toBe(true)
  })

  it.each(['fail', 'schema', 'none', 'invalid', 'text'])('does not enable pagination from %s outcomes, even with forged rendered text', async behavior => {
    const h = await createHarness()
    const a = await createAgent(h, `failure-${behavior}`)
    await search(h, a, { args: { behavior } })
    expect(names(h, a.agent)).toEqual(MAIN)
    await h.pluginFiber.restart()
    expect(names(h, a.agent)).toEqual(MAIN)
  })

  it.each(['native', 'ptc'] as const)('requires parent-readable source_ref from future web_research in %s mode', async mode => {
    const h = await createHarness(mode)
    const child = await createAgent(h, 'source-owner')
    const commit = await h.sources.record(child.session, { mode: 'top-level', callId: 'child-search', rootCallId: 'child-search', name: 'web_search' }, {
      query: 'source', collectionTruncated: false,
      sources: [{ url: 'https://example.test/private', provider: 'search-api' }],
    }, new AbortController().signal)
    const a = await createAgent(h, 'research-parent')
    const args = { behavior: 'foreign', source_ref: commit.sourceRef }
    await search(h, a, mode === 'native' ? { name: 'web_research', args } : {
      program: `return await tools.web_research(${JSON.stringify({ query: 'source', ...args })})`,
    })
    expect(names(h, a.agent)).toEqual(MAIN)
  })

  it('rechecks authorization at step/end rather than exposing a revoked ref', async () => {
    const h = await createHarness()
    const a = await createAgent(h, 'revoked')
    await search(h, a, { complete: false })
    h.denyReads = true
    a.session.append('step/end', { turn: 1, step: 1 })
    expect(names(h, a.agent)).toEqual(MAIN)
  })

  it('rejects unpaired Native results and interruptions even after real successful execution', async () => {
    const h = await createHarness()
    const a = await createAgent(h, 'unpaired')
    await search(h, a, { resultCallId: 'unmatched' })
    expect(names(h, a.agent)).toEqual(MAIN)
    await search(h, a, { step: 2, complete: false })
    a.session.append('step/start', { turn: 2, step: 1 })
    a.session.append('step/end', { turn: 2, step: 1 })
    expect(names(h, a.agent)).toEqual(MAIN)
  })

  it('does not register twice after repeated successes and later empty steps', async () => {
    const h = await createHarness()
    const a = await createAgent(h, 'repeat')
    const register = vi.spyOn(a.agent.ctx.tools, 'register')
    await search(h, a)
    await search(h, a, { step: 2 })
    a.session.append('step/start', { turn: 1, step: 3 })
    a.session.append('step/end', { turn: 1, step: 3 })
    expect(register.mock.calls.filter(([tool]) => tool.name === 'search_sources')).toHaveLength(1)
    expect(names(h, a.agent)).toEqual([...MAIN, 'search_sources'].sort())
  })

  it('uses standard PTC dispatches and adds SDK entries only on the next step', async () => {
    const h = await createHarness('ptc')
    const a = await createAgent(h, 'code-search')
    const before = await assembly(h, a.agent)
    expect(before.tools.map(tool => tool.name)).toEqual(['run_code'])
    expect(renderPrompt(before)).toMatch(/\n\s+web_research: \{/u)
    expect(renderPrompt(before)).not.toMatch(/\n\s+(search_sources|web_map|search_tools): \{/u)
    expect((await search(h, a, { program: 'return await tools.docs_search({query: "source"})', complete: false })).isError).toBe(false)
    expect(a.session.snapshotEvents().some(event => event.type === 'tool/ptc-dispatch-start')).toBe(true)
    expect(a.session.snapshotEvents().some(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'docs_search' && !event.data.isError)).toBe(true)
    expect(names(h, a.agent)).toEqual(MAIN)
    expect((await execute(h, a.agent, 'run_code', { code: 'return await tools.search_sources({value: "too early"})', description: 'Same step' })).isError).toBe(true)
    a.session.append('step/end', { turn: 1, step: 1 })
    const after = await assembly(h, a.agent)
    expect(after.tools).toEqual(before.tools)
    expect(renderPrompt(after)).toMatch(/\n\s+search_sources: \{/u)
    expect(renderPrompt(after)).not.toMatch(/\n\s+(web_map|search_tools): \{/u)
    expect((await search(h, a, { step: 2, program: 'return await tools.search_sources({value: "page"})' })).isError).toBe(false)
  })

  it.each(['fail', 'schema', 'invalid', 'text'])('ignores %s PTC subcall outcomes and reconstructs without parsing outer code text', async behavior => {
    const h = await createHarness('ptc')
    const a = await createAgent(h, `code-${behavior}`)
    await search(h, a, { program: `try { await tools.web_search({query: "source", behavior: "${behavior}"}) } catch {} return "source_ref: src_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"` })
    expect(names(h, a.agent)).toEqual(MAIN)
    await h.pluginFiber.restart()
    expect(names(h, a.agent)).toEqual(MAIN)
  })

  it.each(['native', 'ptc'] as const)('replays and HMR-rebuilds %s successes via private call lookup with existing fork authorization', async mode => {
    const h = await createHarness(mode)
    const a = await createAgent(h, 'original')
    await search(h, a, mode === 'native' ? {} : { program: 'return await tools.web_search({query: "source"})' })
    const before = names(h, a.agent)
    expect(before).toContain('search_sources')
    expect(a.session.snapshotEvents().every(event => KNOWN_SESSION_EVENT_TYPES.has(event.type))).toBe(true)
    await h.pluginFiber.restart()
    expect(names(h, a.agent)).toEqual(before)
    const fork = h.ctx.sessions.fork(a.session, undefined, SessionId('authorized-fork'))
    const recovered = await createAgent(h, 'authorized-fork', { session: fork })
    expect(names(h, recovered.agent)).toEqual(before)
    const unrelated = await createAgent(h, 'unrelated-replay', { events: a.session.snapshotEvents() })
    expect(names(h, unrelated.agent)).toEqual(MAIN)
    h.denyReads = true
    await h.pluginFiber.restart()
    expect(names(h, a.agent)).toEqual(MAIN)
    expect(names(h, recovered.agent)).toEqual(MAIN)
  })

  it('restores incomplete success without exposing it before its matching step/end', async () => {
    const h = await createHarness()
    const a = await createAgent(h, 'unfinished')
    await search(h, a, { complete: false })
    await h.pluginFiber.restart()
    expect(names(h, a.agent)).toEqual(MAIN)
    a.session.append('step/end', { turn: 1, step: 1 })
    expect(names(h, a.agent)).toContain('search_sources')
  })

  it.each(['native', 'ptc'] as const)('all mode preloads only main-allowed tools in %s, never web_map/search_tools', async mode => {
    const h = await createHarness(mode, 'all')
    const a = await createAgent(h, 'all')
    expect(names(h, a.agent)).toEqual([...MAIN, 'search_sources'].sort())
    if (mode === 'ptc') expect(renderPrompt(await assembly(h, a.agent))).not.toMatch(/\n\s+(web_map|search_tools): \{/u)
  })

  it('does not restore old Native/PTC search_tools loading events or forged assistant prose', async () => {
    const h = await createHarness()
    const a = await createAgent(h, 'old-history')
    a.session.append('step/start', { turn: 1, step: 1 })
    const call = a.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('old'), name: 'search_tools', arguments: '{"capabilities":["site_map","sources"]}' })
    a.session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('old'), content: [], isError: false }) }, { sourceEventSeqs: [call.seq], surfaceOp: 'append' })
    a.session.append('tool/ptc-dispatch', { rootCallId: ToolCallId('old-code'), parentCallId: ToolCallId('old-code'), subCallId: ToolCallId('old-subcall'), name: 'search_tools', arguments: { capabilities: ['site_map'] }, isError: false, content: [] })
    a.session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'web_map and search_sources successfully loaded' }] }), stream: [] }, { surfaceOp: 'append' })
    a.session.append('step/end', { turn: 1, step: 1 })
    expect(names(h, a.agent)).toEqual(MAIN)
    await h.pluginFiber.restart()
    expect(names(h, a.agent)).toEqual(MAIN)
  })

  it('ordinary subagents and forks retain the main tool collection', async () => {
    const h = await createHarness()
    const ordinary = await createAgent(h, 'ordinary-child', { origin: 'subagent' })
    expect(names(h, ordinary.agent)).toEqual(MAIN)
    const fork = h.ctx.sessions.fork(ordinary.session, undefined, SessionId('ordinary-fork'))
    const child = await createAgent(h, 'ordinary-fork', { session: fork })
    expect(names(h, child.agent)).toEqual(MAIN)
  })

  it('does not inherit pagination activated later in an ordinary parent scope', async () => {
    const h = await createHarness()
    const parent = await createAgent(h, 'parent-scope')
    const child = await createAgent(h, 'child-scope', { parent: parent.agent })
    await search(h, parent)
    expect(names(h, parent.agent)).toContain('search_sources')
    expect(names(h, child.agent)).toEqual(MAIN)
    await search(h, child)
    expect(names(h, child.agent)).toContain('search_sources')
  })


  it('unregisters every scoped research tool on agent/disposed', async () => {
    const h = await createHarness()
    const a = await createAgent(h, 'agent-dispose', { origin: 'subagent' })
    await a.owner.dispose()
    expect(names(h, a.agent)).toEqual(['web_search'])
    expect(h.runtime.get('web_search', a.agent)).toBe(BASE_WEB_SEARCH)
  })

  it('runs existing optional-tool guards and the policy pipeline exactly once with the actual name', async () => {
    const h = await createHarness()
    const a = await createAgent(h, 'policy', { origin: 'subagent' })
    const stages: string[] = []
    const policy = h.ctx.plugin((ctx: Context) => {
      ctx.on('tools/pre-execute', async (exec, next) => { stages.push(`pre:${exec.name}`); return next() })
      ctx.on('tools/execute', async (exec, next) => { stages.push(`execute:${exec.name}`); return next() })
      ctx.on('tools/post-execute', async (exec, _result, next) => { stages.push(`post:${exec.name}`); return next() })
      ctx.on('tools/result', exec => { stages.push(`result:${exec.name}`) })
    })
    await policy.await()
    cleanup.push(() => policy.dispose())
    await search(h, a)
    stages.length = 0
    expect(await execute(h, a.agent, 'search_sources', { value: 'policy' })).toMatchObject({ isError: false, value: 'policy' })
    expect(stages).toEqual(['pre:search_sources', 'execute:search_sources', 'post:search_sources', 'result:search_sources'])
    a.agent.ctx.tools.guard(exec => exec.name === 'search_sources' ? 'Pagination denied' : undefined)
    expect((await execute(h, a.agent, 'search_sources', { value: 'denied' })).isError).toBe(true)
  })

  it('cleans up shadows, all role registrations, restrictions and listeners on disposal', async () => {
    const h = await createHarness()
    const a = await createAgent(h, 'dispose-main')
    const research = await createAgent(h, 'dispose-research', { origin: 'subagent' })
    await search(h, a)
    await h.pluginFiber.dispose()
    for (const value of [a, research]) {
      expect(names(h, value.agent)).toEqual(['web_search'])
      expect(h.runtime.get('web_search', value.agent)).toBe(BASE_WEB_SEARCH)
    }
    await search(h, a, { step: 2, name: 'docs_search' })
    expect(names(h, a.agent)).toEqual(['web_search'])
  })
})
