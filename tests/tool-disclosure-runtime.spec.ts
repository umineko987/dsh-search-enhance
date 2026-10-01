import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { PtcRuntime, type PtcRunRequest, type PtcRunResult, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { SessionId, SessionStore, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SystemPrompt, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool, type ToolDefinition, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'

import {
  EVIDENCE_DISCIPLINE_GUIDANCE,
  TOOL_DISCOVERY_GUIDANCE,
  registerToolDiscoveryGuidance,
} from '../src/prompt/tool-discovery.js'
import { RESIDENT_TOOL_NAMES, installAgentToolDisclosure, type AgentToolDisclosureManager } from '../src/tool-discovery/index.js'
import { createSearchToolsTool } from '../src/tools/search-tools.js'

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

const BASE_WEB_SEARCH = textTool('web_search')
const RICH_WEB_SEARCH = defineTool({
  name: 'web_search', description: 'Rich Agent-scoped web search stub.',
  parameters: { query: { type: 'string', required: true }, profile: { type: 'string' } },
  output: {
    schema: { type: 'object', properties: { source_ref: { type: 'string', required: true } }, additionalProperties: false },
    render: (_args, value) => [{ type: 'text', text: `Source reference: ${value.source_ref}` }],
  },
  async execute() { return { source_ref: 'src_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } },
})

interface TestAgent {
  readonly agent: Agent
  readonly owner: ReturnType<Context['plugin']>
  readonly scope: Scope
  readonly session: Session
}

interface Harness {
  readonly ctx: Context
  readonly runtime: ToolRuntime
  readonly baseFiber: ReturnType<Context['plugin']>
  pluginFiber: ReturnType<Context['plugin']>
  manager: AgentToolDisclosureManager
}

/** Only SDK presentation is exercised; this stub does not execute Code programs. */
class PresentationPtcRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'test'
  resolve(_request: PtcRunRequest): PtcRunSpec { throw new Error('Not exercised') }
  run(_spec: PtcRunSpec): Promise<PtcRunResult> { throw new Error('Not exercised') }
}

async function createHarness(mode: 'native' | 'ptc' = 'native', discovery: 'progressive' | 'all' = 'progressive'): Promise<Harness> {
  const ctx = new Context()
  new SessionStore(ctx)
  new AgentRegistry(ctx)
  new SystemPrompt(ctx, {})
  if (mode === 'ptc') new PresentationPtcRuntime(ctx)
  const runtime = new ToolRuntime(ctx, { mode })
  const baseFiber = ctx.plugin((pluginCtx: Context) => { pluginCtx.tools.register(BASE_WEB_SEARCH) })
  await baseFiber.await()
  const harness = { ctx, runtime, baseFiber } as Harness
  harness.pluginFiber = ctx.plugin((pluginCtx: Context) => {
    pluginCtx.tools.register(textTool('docs_search'))
    pluginCtx.tools.register(textTool('web_extract'))
    harness.manager = installAgentToolDisclosure(pluginCtx, {
      mode: discovery, webSearchDefinition: RICH_WEB_SEARCH,
      deferredTools: { sources: optionalTool('search_sources'), site_map: optionalTool('web_map') },
    })
    pluginCtx.tools.register(createSearchToolsTool(harness.manager))
    registerToolDiscoveryGuidance(pluginCtx)
  })
  await harness.pluginFiber.await()
  return harness
}

async function createAgent(ctx: Context, id: string, options: {
  readonly events?: readonly SessionEvent[]; readonly parent?: ScopeKey
} = {}): Promise<TestAgent> {
  const session = ctx.sessions.create(SessionId(id), options.events === undefined ? undefined : { seed: options.events })
  const mutable = { id: session.id, options: {}, session, ctx: undefined } as unknown as Agent & { ctx: Context }
  const scope = createScope(ctx, mutable, options.parent === undefined ? undefined : { parent: options.parent })
  mutable.ctx = scope.ctx
  const agent = mutable as Agent
  const owner = ctx.plugin((pluginCtx: Context) => { pluginCtx.agents.register(agent) })
  await owner.await()
  return { agent, owner, scope, session }
}

async function disposeAgent(value: TestAgent): Promise<void> {
  await value.owner.dispose()
  await value.scope.dispose()
}

async function disposeHarness(value: Harness): Promise<void> {
  await value.pluginFiber.dispose()
  await value.baseFiber.dispose()
  await value.ctx.fiber.dispose()
}

function execute(harness: Harness, agent: Agent, name: string, args: unknown): Promise<ToolExecutionResult> {
  return harness.runtime.execute({
    callId: ToolCallId(`${name}-${Math.random()}`), name, arguments: args,
    agent, signal: new AbortController().signal,
  })
}

async function load(harness: Harness, value: TestAgent, capabilities: readonly string[], step = 1, complete = true): Promise<ToolExecutionResult> {
  value.session.append('step/start', { turn: 1, step })
  const callId = ToolCallId(`load-${step}`)
  const args = { capabilities }
  const call = value.session.append('tool/call', {
    turn: 1, step, callId, name: 'search_tools', arguments: JSON.stringify(args),
  })
  const result = await execute(harness, value.agent, 'search_tools', args)
  value.session.append('tool/result', {
    turn: 1, step, message: createToolResultMessage({ callId, content: [...result.content], isError: result.isError }),
  }, { sourceEventSeqs: [call.seq], surfaceOp: 'append' })
  if (complete) value.session.append('step/end', { turn: 1, step })
  return result
}

function names(harness: Harness, agent: Agent): string[] {
  return harness.runtime.schemas(agent).map(tool => tool.name).sort()
}

async function assembly(harness: Harness, agent: Agent) {
  return harness.ctx.systemPrompt.assemble({ scope: agent, agent })
}

describe('on-demand real tools with the DSH runtime', () => {
  it('keeps routing, optional-tool timing, safety and evidence rules in shorter guidance', () => {
    expect(TOOL_DISCOVERY_GUIDANCE).toMatch(/docs_search.*known library identity.*omit.*broad\/cross-project.*unknown-library.*auto uses Exa/u)
    expect(TOOL_DISCOVERY_GUIDANCE).toContain('Never guess a Context7 library')
    expect(TOOL_DISCOVERY_GUIDANCE).toMatch(/web_extract.*exactly one enabled Provider.*web_fetch.*structured responses/u)
    expect(TOOL_DISCOVERY_GUIDANCE).toMatch(/Prefer HTTPS.*title\/app shell.*not usable page-body evidence.*instead of refetching/u)
    expect(TOOL_DISCOVERY_GUIDANCE).toContain('Never bypass URL safety checks')
    expect(TOOL_DISCOVERY_GUIDANCE).toMatch(/sources via search_tools for source_ref pagination.*site_map.*known site/u)
    expect(TOOL_DISCOVERY_GUIDANCE).toMatch(/newly loaded search_sources\/web_map directly on the next model step.*reuse loaded tools.*not load preemptively/u)
    expect(EVIDENCE_DISCIPLINE_GUIDANCE).toMatch(/one focused web_search.*docs_search for SDK\/API docs/u)
    expect(EVIDENCE_DISCIPLINE_GUIDANCE).toMatch(/do not inspect local files\/settings\/sessions\/credentials unless the user explicitly asks/u)
    expect(EVIDENCE_DISCIPLINE_GUIDANCE).toMatch(/answers\/snippets.*source metadata.*mapped URLs.*discovery, not claim-level evidence/u)
    expect(EVIDENCE_DISCIPLINE_GUIDANCE).toMatch(/factual\/causal conclusions.*authoritative URLs with web_extract.*inference or unconfirmed, never source-stated fact/u)
    expect(TOOL_DISCOVERY_GUIDANCE.length + EVIDENCE_DISCIPLINE_GUIDANCE.length).toBeLessThan(2189)
  })

  it('loads on the next Native step, isolates Agents, and calls real tools directly', async () => {
    const harness = await createHarness()
    const a = await createAgent(harness.ctx, 'native-a')
    const b = await createAgent(harness.ctx, 'native-b')
    try {
      expect(names(harness, a.agent)).toEqual([...RESIDENT_TOOL_NAMES].sort())
      expect(renderPrompt(await assembly(harness, a.agent))).toContain(TOOL_DISCOVERY_GUIDANCE)
      expect(renderPrompt(await assembly(harness, a.agent))).toContain(EVIDENCE_DISCIPLINE_GUIDANCE)
      expect(harness.runtime.get('search_call', a.agent)).toBeUndefined()
      expect((await execute(harness, a.agent, 'web_map', { value: 'x' })).isError).toBe(true)
      expect(await load(harness, a, ['site_map'], 1, false)).toMatchObject({
        isError: false, value: { tools: ['web_map'], takes_effect: 'next_step' },
      })
      expect(harness.runtime.get('web_map', a.agent)).toBeUndefined()
      a.session.append('step/end', { turn: 1, step: 1 })
      expect(names(harness, a.agent)).toEqual([...RESIDENT_TOOL_NAMES, 'web_map'].sort())
      expect(names(harness, b.agent)).toEqual([...RESIDENT_TOOL_NAMES].sort())
      expect(await execute(harness, a.agent, 'web_map', { value: 'mapped' })).toMatchObject({ isError: false, value: 'mapped' })
      expect(await execute(harness, a.agent, 'web_map', {})).toMatchObject({ isError: true, error: { info: { code: 'INVALID_ARGS' } } })
      const search = await execute(harness, a.agent, 'web_search', { query: 'source' })
      expect(search.isError).toBe(false)
      expect(harness.runtime.get('search_sources', a.agent)).toBeUndefined()
      await load(harness, a, ['sources'], 2)
      expect(await execute(harness, a.agent, 'search_sources', { value: 'page' })).toMatchObject({ isError: false, value: 'page' })
      const recovered = await createAgent(harness.ctx, 'native-recovered', { events: a.session.snapshotEvents() })
      try {
        expect(names(harness, recovered.agent)).toEqual(names(harness, a.agent))
        expect(await execute(harness, recovered.agent, 'web_map', { value: 'restored' })).toMatchObject({ isError: false, value: 'restored' })
      } finally { await disposeAgent(recovered) }
    } finally {
      await disposeAgent(b)
      await disposeAgent(a)
      await disposeHarness(harness)
    }
  })

  it('adds real Code SDK entries, keeps run_code schema stable, and restores standard dispatch history', async () => {
    const harness = await createHarness('ptc')
    const agent = await createAgent(harness.ctx, 'code-loading')
    try {
      const before = await assembly(harness, agent.agent)
      expect(renderPrompt(before)).toContain(TOOL_DISCOVERY_GUIDANCE)
      expect(renderPrompt(before)).toContain(EVIDENCE_DISCIPLINE_GUIDANCE)
      expect(before.tools.map(tool => tool.name)).toEqual(['run_code'])
      expect(renderPrompt(before)).not.toMatch(/\n\s+web_map: \{/u)
      agent.session.append('step/start', { turn: 1, step: 1 })
      agent.session.append('tool/ptc-dispatch', {
        rootCallId: ToolCallId('code'), parentCallId: ToolCallId('code'), subCallId: ToolCallId('code:ptc:1'),
        name: 'search_tools', arguments: { capabilities: ['site_map'] }, isError: false, content: [],
      })
      expect(harness.runtime.get('web_map', agent.agent)).toBeUndefined()
      agent.session.append('step/end', { turn: 1, step: 1 })
      const after = await assembly(harness, agent.agent)
      expect(after.tools).toEqual(before.tools)
      expect(renderPrompt(after)).toMatch(/\n\s+web_map: \{/u)
      expect(renderPrompt(after)).not.toContain('search_call:')
      const recovered = await createAgent(harness.ctx, 'code-recovered', { events: agent.session.snapshotEvents() })
      try { expect(renderPrompt(await assembly(harness, recovered.agent))).toEqual(renderPrompt(after)) }
      finally { await disposeAgent(recovered) }
    } finally {
      await disposeAgent(agent)
      await disposeHarness(harness)
    }
  })

  it('rebuilds loaded tools on HMR and removes them and the web_search shadow on disposal', async () => {
    const harness = await createHarness()
    const agent = await createAgent(harness.ctx, 'hmr')
    try {
      await load(harness, agent, ['site_map'])
      expect(harness.runtime.get('web_search', agent.agent)).toBe(RICH_WEB_SEARCH)
      const before = names(harness, agent.agent)
      await harness.pluginFiber.restart()
      expect(names(harness, agent.agent)).toEqual(before)
      expect(harness.runtime.get('web_search', agent.agent)).toBe(RICH_WEB_SEARCH)
      await harness.pluginFiber.dispose()
      expect(harness.runtime.get('web_search', agent.agent)).toBe(BASE_WEB_SEARCH)
      expect(names(harness, agent.agent)).toEqual(['web_search'])
    } finally {
      await disposeAgent(agent)
      await disposeHarness(harness)
    }
  })

  it('honors inherited web_search restrictions and optional-tool guards', async () => {
    const harness = await createHarness()
    const presetKey: ScopeKey = {}
    const preset = createScope(harness.ctx, presetKey)
    preset.ctx.tools.restrict({ deny: ['web_search'] })
    preset.ctx.tools.guard(exec => exec.name === 'web_map' ? 'Site mapping denied by Preset' : undefined)
    const agent = await createAgent(harness.ctx, 'restricted', { parent: presetKey })
    try {
      await load(harness, agent, ['site_map', 'sources'])
      expect(harness.runtime.get('web_search', agent.agent)).toBeUndefined()
      expect(harness.runtime.get('web_map', agent.agent)).toBeDefined()
      expect(harness.runtime.get('search_sources', agent.agent)).toBeDefined()
      expect((await execute(harness, agent.agent, 'web_map', { value: 'denied' })).isError).toBe(true)
    } finally {
      await disposeAgent(agent)
      await preset.dispose()
      await disposeHarness(harness)
    }
  })

  it('runs the host policy pipeline once using the real optional tool name', async () => {
    const harness = await createHarness()
    const stages: string[] = []
    const policy = harness.ctx.plugin((ctx: Context) => {
      ctx.on('tools/pre-execute', async (exec, next) => { stages.push(`pre:${exec.name}`); return next() })
      ctx.on('tools/execute', async (exec, next) => { stages.push(`execute:${exec.name}`); return next() })
      ctx.on('tools/post-execute', async (exec, _result, next) => { stages.push(`post:${exec.name}`); return next() })
      ctx.on('tools/result', exec => { stages.push(`result:${exec.name}`) })
    })
    await policy.await()
    const agent = await createAgent(harness.ctx, 'policy')
    try {
      await load(harness, agent, ['site_map'])
      stages.length = 0
      expect(await execute(harness, agent.agent, 'web_map', { value: 'policy' })).toMatchObject({ isError: false, value: 'policy' })
      expect(stages).toEqual(['pre:web_map', 'execute:web_map', 'post:web_map', 'result:web_map'])
    } finally {
      await disposeAgent(agent)
      await policy.dispose()
      await disposeHarness(harness)
    }
  })

  it('keeps all mode as immediate registration and does not load invalid requests', async () => {
    const all = await createHarness('native', 'all')
    const allAgent = await createAgent(all.ctx, 'all')
    try {
      expect(names(all, allAgent.agent)).toEqual([...RESIDENT_TOOL_NAMES, 'search_sources', 'web_map'].sort())
      expect(await execute(all, allAgent.agent, 'search_tools', { capabilities: ['sources'] })).toMatchObject({
        isError: false, value: { takes_effect: 'already_active', added_groups: [] },
      })
    } finally {
      await disposeAgent(allAgent)
      await disposeHarness(all)
    }
    const progressive = await createHarness()
    const agent = await createAgent(progressive.ctx, 'invalid')
    try {
      expect((await load(progressive, agent, ['planning'])).isError).toBe(true)
      expect(names(progressive, agent.agent)).toEqual([...RESIDENT_TOOL_NAMES].sort())
    } finally {
      await disposeAgent(agent)
      await disposeHarness(progressive)
    }
  })
})
