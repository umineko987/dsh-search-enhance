import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config } from '../src/config.js'
import { ResearchExecutor } from '../src/research/executor.js'
import { resolveResearchModel } from '../src/research/model.js'
import { createResearchPersona } from '../src/research/persona.js'
import { startSdkResearch } from '../src/research/sdk.js'
import type { ResearchReport } from '../src/research/report.js'

vi.mock('../src/research/model.js', () => ({ resolveResearchModel: vi.fn() }))
vi.mock('../src/research/sdk.js', () => ({ startSdkResearch: vi.fn() }))
const REPORT: ResearchReport = { conclusions: [], limitations: ['No evidence available.'], stop_reason: 'evidence_limited' }
const cleanup: Array<() => Promise<void>> = []
beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers() })
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.useRealTimers() })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function harness() {
  const ctx = new Context()
  const parent = { id: 'parent' } as Agent
  ctx.provide('agents', { get: () => parent } as unknown as Context['agents'])
  const executor = new ResearchExecutor(ctx, () => Config({} as never))
  const dispose = vi.fn(async () => {})
  const child = {
    run: { result: Promise.resolve({ stopReason: 'completed' }) },
    bridge: { finished: Promise.resolve(), report: () => REPORT }, dispose,
  }
  vi.mocked(resolveResearchModel).mockResolvedValue({ route: { provider: 'deepseek-official', model: 'test-model' }, connection: {} as never, auth: async () => ({ 'x-api-key': 'fixture' }) })
  vi.mocked(startSdkResearch).mockResolvedValue(child as never)
  cleanup.push(async () => { executor.dispose(); await ctx.fiber.dispose() })
  return { ctx, parent, executor, child, dispose, run: (timeoutMs?: number, signal = new AbortController().signal) => executor.run({ parent, query: 'Self-contained research task.', ...(timeoutMs === undefined ? {} : { timeoutMs }), signal }) }
}
describe('research search discipline', () => {
  it('prioritizes retained evidence and requires a meaningful gap before searching again', () => {
    const prompt = createResearchPersona(60000, 12000)
    expect(prompt).toContain('Plan one focused initial query')
    expect(prompt).toContain('prioritize reusing existing results')
    expect(prompt).toContain('search_sources and read original pages with web_extract')
    expect(prompt).toContain('Before any follow-up web_search, identify the specific unresolved evidence gap')
    expect(prompt).toContain('cannot be filled from retained sources')
    expect(prompt).toContain('Do not repeat searches for the same question with cosmetic keyword changes, run overlapping searches')
    expect(prompt).toContain('or ask the search model to re-analyze or summarize material already retrieved')
    expect(prompt).toContain('The time budget is a ceiling, not a search quota')
    expect(prompt).toContain('report it as a limitation instead of searching indefinitely')
    expect(prompt).not.toContain('Use multiple focused searches when needed')
  })
})
describe('isolated research executor lifecycle', () => {
  it.each([0, -1, 59999, 3600001, 60000.5, NaN, Infinity])('rejects invalid budget %s before authentication or startup', async timeout => {
    const h = harness()
    await expect(h.run(timeout)).rejects.toThrow(/timeout_ms/)
    expect(resolveResearchModel).not.toHaveBeenCalled()
    expect(startSdkResearch).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each([undefined, 60000, 60005, 3600000])('propagates independent deadlines for budget %s and cleans up', async timeout => {
    const h = harness(), started = Date.now()
    await expect(h.run(timeout)).resolves.toEqual(REPORT)
    const request = vi.mocked(startSdkResearch).mock.calls[0]![1]
    const total = timeout ?? 600000
    expect(request.bootstrap).toMatchObject({ timeoutMs: total, finishMs: Math.min(total * .2, 120000), hardDeadline: started + total, softDeadline: started + total - Math.min(total * .2, 120000) })
    expect(request.parent).toBe(h.parent)
    expect(request.route.model).toBe('test-model')
    expect(h.dispose).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not return a report until formal delivery has finished', async () => {
    const h = harness(), finish = deferred<void>()
    h.child.bridge.finished = finish.promise
    let done = false
    const pending = h.run().then(value => { done = true; return value })
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(false)
    finish.resolve()
    await expect(pending).resolves.toEqual(REPORT)
  })
  it.each([false, true])('hard deadline retains only a formally delivered report (accepted=%s)', async accepted => {
    const h = harness()
    h.child.run.result = new Promise(() => {})
    h.child.bridge.report = () => accepted ? { ...REPORT, stop_reason: 'budget_exhausted' } : undefined as never
    const pending = h.run(60000)
    const assertion = accepted ? expect(pending).resolves.toMatchObject({ stop_reason: 'budget_exhausted' }) : expect(pending).rejects.toThrow(/time budget exceeded/)
    await vi.advanceTimersByTimeAsync(60000)
    await assertion
    expect(vi.mocked(startSdkResearch).mock.calls[0]![1].signal.aborted).toBe(true)
    expect(h.dispose).toHaveBeenCalledOnce()
  })
  it.each(['caller', 'dispose'] as const)('prioritizes %s cancellation over an accepted report', async source => {
    const h = harness(), controller = new AbortController()
    h.child.run.result = new Promise(() => {})
    const pending = h.run(60000, controller.signal)
    const assertion = expect(pending).rejects.toThrow(source === 'caller' ? 'caller cancelled' : 'executor disposed')
    await vi.advanceTimersByTimeAsync(0)
    if (source === 'caller') controller.abort(new Error('caller cancelled'))
    else h.executor.dispose()
    await assertion
    expect(h.dispose).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cancels delayed authentication without starting a late process', async () => {
    const h = harness(), auth = deferred<Awaited<ReturnType<typeof resolveResearchModel>>>()
    vi.mocked(resolveResearchModel).mockReturnValue(auth.promise)
    const controller = new AbortController()
    const pending = h.run(60000, controller.signal)
    const assertion = expect(pending).rejects.toThrow('cancel auth')
    controller.abort(new Error('cancel auth'))
    await assertion
    auth.resolve({ route: {}, connection: {} as never, auth: async () => ({ 'x-api-key': 'fixture' }) })
    await vi.advanceTimersByTimeAsync(0)
    expect(startSdkResearch).not.toHaveBeenCalled()
  })
  it.each(['error', 'max-tokens'])('rejects SDK termination %s even if the bridge has a report', async stopReason => {
    const h = harness()
    h.child.run.result = Promise.resolve({ stopReason })
    await expect(h.run()).rejects.toThrow(/web_research failed/)
    expect(h.dispose).toHaveBeenCalledOnce()
  })
  it('rejects plain text completion without a structured report', async () => {
    const h = harness()
    h.child.bridge.report = () => undefined as never
    await expect(h.run()).rejects.toThrow(/invalid structured report/)
    expect(h.dispose).toHaveBeenCalledOnce()
  })
})
