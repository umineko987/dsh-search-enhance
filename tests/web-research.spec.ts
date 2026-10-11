import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'

import { ResearchExecutor, type ResearchRequest } from '../src/research/executor.js'
import { RESEARCH_REPORT_SCHEMA, validateResearchReport, type ResearchReport } from '../src/research/report.js'
import { ForegroundOperationScope } from '../src/tools/operations.js'
import { createWebResearchTool } from '../src/tools/web-research.js'

const REPORT: ResearchReport = {
  conclusions: [{ statement: 'Supported conclusion.', sources: [{ url: 'https://example.test/', excerpt: 'Observed excerpt.', reading: 'summary_only' }] }],
  limitations: ['Only a search summary was available.'], stop_reason: 'evidence_limited',
}

describe('web_research tool boundary', () => {
  it('exposes self-contained query and optional per-call timeout, preserves parent and uses ForegroundOperationScope', async () => {
    const ctx = new Context()
    new AgentRegistry(ctx)
    new SystemPrompt(ctx, {})
    const runtime = new ToolRuntime(ctx, {})
    const operations = new ForegroundOperationScope()
    const run = vi.fn(async (_request: ResearchRequest) => REPORT)
    runtime.register(createWebResearchTool({ research: { run }, operations }))
    const parent = {} as Agent
    const controller = new AbortController()
    try {
      const schema = runtime.schemas()[0]!
      const parameters = schema.parameters
      assertObjectJsonSchema(parameters)
      expect(Object.keys(parameters.properties!)).toEqual(['query', 'timeout_ms'])
      expect(parameters.required).toEqual(['query'])
      expect(parameters.properties!.timeout_ms).toMatchObject({ type: 'integer' })
      expect(parameters.properties!.timeout_ms!.description).toContain('600000 (10 minutes)')
      expect(parameters.properties!.timeout_ms!.description).toContain('60000–3600000')
      const result = await runtime.execute({ name: 'web_research', callId: ToolCallId('research'), arguments: { query: 'Question; restrict scope to official documentation.' }, agent: parent, signal: controller.signal })
      expect(result.isError).toBeFalsy()
      expect(result.value).toEqual(REPORT)
      expect(run).toHaveBeenCalledOnce()
      expect(run.mock.calls[0]![0]).toMatchObject({ parent, query: 'Question; restrict scope to official documentation.' })
      expect(run.mock.calls[0]![0].timeoutMs).toBeUndefined() // Only the executor resolves defaults.
      const signal = run.mock.calls[0]![0].signal
      expect(signal).not.toBe(controller.signal)
      controller.abort()
      expect(signal.aborted).toBe(true)
      expect(JSON.stringify(result.content)).not.toContain('source_ref')
    } finally { await operations.stop(); await ctx.fiber.dispose() }
  })

  it.each([undefined, 60_000, 60_005, 180_000, 3_600_000])('forwards the optional budget without defaulting or clamping (%s ms)', async timeoutMs => {
    const ctx = new Context()
    new AgentRegistry(ctx)
    new SystemPrompt(ctx, {})
    const runtime = new ToolRuntime(ctx, {})
    const operations = new ForegroundOperationScope()
    const run = vi.fn(async (_request: ResearchRequest) => REPORT)
    runtime.register(createWebResearchTool({ research: { run }, operations }))
    try {
      const args = timeoutMs === undefined ? { query: 'Question' } : { query: 'Question', timeout_ms: timeoutMs }
      const result = await runtime.execute({ name: 'web_research', callId: ToolCallId('budget'), arguments: args, agent: {} as Agent, signal: new AbortController().signal })
      expect(result.isError).toBeFalsy()
      expect(run).toHaveBeenCalledOnce()
      expect(run.mock.calls[0]![0].timeoutMs).toBe(timeoutMs)
    } finally { await operations.stop(); await ctx.fiber.dispose() }
  })

  it.each([{}, { query: 42 }, { query: '' }, { query: '   ' }])('rejects invalid input %j without dispatching research', async args => {
    const ctx = new Context()
    new AgentRegistry(ctx)
    new SystemPrompt(ctx, {})
    const runtime = new ToolRuntime(ctx, {})
    const operations = new ForegroundOperationScope()
    const run = vi.fn(async (_request: ResearchRequest) => REPORT)
    runtime.register(createWebResearchTool({ research: { run }, operations }))
    try {
      const result = await runtime.execute({ name: 'web_research', callId: ToolCallId('invalid'), arguments: args, agent: {} as Agent, signal: new AbortController().signal })
      expect(result.isError).toBe(true)
      expect(run).not.toHaveBeenCalled()
    } finally { await operations.stop(); await ctx.fiber.dispose() }
  })

  it('requires an Agent and refuses new calls after operations.stop', async () => {
    const ctx = new Context()
    new AgentRegistry(ctx)
    new SystemPrompt(ctx, {})
    const runtime = new ToolRuntime(ctx, {})
    const operations = new ForegroundOperationScope()
    const run = vi.fn(async (_request: ResearchRequest) => REPORT)
    runtime.register(createWebResearchTool({ research: { run }, operations }))
    try {
      const agentless = await runtime.execute({ name: 'web_research', callId: ToolCallId('no-agent'), arguments: { query: 'Question' }, signal: new AbortController().signal })
      expect(agentless.isError).toBe(true)
      await operations.stop()
      const stopped = await runtime.execute({ name: 'web_research', callId: ToolCallId('stopped'), arguments: { query: 'Question' }, agent: {} as Agent, signal: new AbortController().signal })
      expect(stopped.isError).toBe(true)
      expect(run).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })

  it('executor rejects a non-live parent before starting a subagent', async () => {
    const ctx = new Context()
    new AgentRegistry(ctx)
    const research = new ResearchExecutor(ctx, () => { throw new Error('should not prepare') })
    try {
      await expect(research.run({ parent: { id: 'not-live' } as Agent, query: 'Question', signal: new AbortController().signal })).rejects.toThrow(/live Agent/)
    } finally { research.dispose(); await ctx.fiber.dispose() }
  })
})

describe('research report output boundary', () => {
  it('uses the supported SDK schema and accepts a limited summary-only report', () => {
    expect(() => assertObjectJsonSchema(RESEARCH_REPORT_SCHEMA)).not.toThrow()
    expect(validateJsonSchemaValue(RESEARCH_REPORT_SCHEMA, REPORT)).toEqual([])
    expect(validateResearchReport(REPORT)).toEqual(REPORT)
    expect(validateResearchReport({ conclusions: [], limitations: ['No sources accessible.'], stop_reason: 'evidence_limited' }).conclusions).toEqual([])
    const partial = { ...REPORT, stop_reason: 'budget_exhausted' }
    expect(validateJsonSchemaValue(RESEARCH_REPORT_SCHEMA, partial)).toEqual([])
    expect(validateResearchReport(partial).stop_reason).toBe('budget_exhausted')
    expect(validateResearchReport({ conclusions: [], limitations: ['No evidence before budget exhausted.'], stop_reason: 'budget_exhausted' }).conclusions).toEqual([])
  })

  it.each([
    undefined,
    'a final answer',
    { ...REPORT, source_ref: 'src_PRIVATE' },
    { ...REPORT, conclusions: [] , limitations: [] },
    { ...REPORT, stop_reason: 'guessed' },
    { ...REPORT, stop_reason: 'budget_exhausted', limitations: [] },
    { ...REPORT, conclusions: [{ statement: 'Unsourced', sources: [] }] },
    { ...REPORT, conclusions: [{ statement: 'Fact', sources: [{ url: 'file:///private', excerpt: 'text', reading: 'full_text' }] }] },
    { ...REPORT, conclusions: [{ statement: 'Fact', sources: [{ url: 'https://example.test', excerpt: 'text', reading: 'pretended' }] }] },
  ])('rejects missing or misleading report %j', value => {
    expect(() => validateResearchReport(value)).toThrow(/invalid structured report/)
  })

  it('accepts reports without character, item-count or total-byte ceilings', () => {
    const value: ResearchReport = {
      conclusions: Array.from({ length: 9 }, () => ({ statement: '界'.repeat(2500), sources: Array.from({ length: 7 }, () => ({ url: `https://example.test/${'a'.repeat(2500)}`, excerpt: '界'.repeat(2500), reading: 'full_text' })) })),
      limitations: Array.from({ length: 13 }, () => '界'.repeat(1200)), stop_reason: 'completed',
    }
    expect(validateResearchReport(value)).toEqual(value)
  })
})
