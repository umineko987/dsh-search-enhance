import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Config } from '../config.js'
import { resolveResearchModel } from './model.js'
import { validateResearchReport, type ResearchReport } from './report.js'
import { startSdkResearch } from './sdk.js'

export const RESEARCH_DEFAULT_TIMEOUT_MS = 600_000
export const RESEARCH_MIN_TIMEOUT_MS = 60_000
export const RESEARCH_MAX_TIMEOUT_MS = 3_600_000

export interface ResearchRequest {
  readonly query: string
  readonly timeoutMs?: number
  readonly parent: Agent
  readonly signal: AbortSignal
}

export class ResearchBudgetError extends Error {
  readonly budget = 'time'
  constructor() { super('web_research time budget exceeded'); this.name = 'ResearchBudgetError' }
}

/** Cancel a wait without letting a late public credential lookup start a process. */
async function cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try { return await Promise.race([work, cancelled]) }
  finally { signal.removeEventListener('abort', abort) }
}

/** Every invocation owns an official SDK backend and isolated, disposable home. */
export class ResearchExecutor {
  private readonly shutdown = new AbortController()
  constructor(private readonly ctx: Context, private readonly getConfig: () => Config) {
    ctx.effect(() => () => this.dispose())
  }

  async run(request: ResearchRequest): Promise<ResearchReport> {
    const started = Date.now()
    const callerSignal = AbortSignal.any([request.signal, this.shutdown.signal])
    callerSignal.throwIfAborted()
    if (this.ctx.agents.get(request.parent.id) !== request.parent) throw new Error('web_research requires a live Agent')
    if (request.query.trim().length === 0) throw new Error('web_research query must not be empty')
    const timeoutMs = request.timeoutMs ?? RESEARCH_DEFAULT_TIMEOUT_MS
    if (!Number.isInteger(timeoutMs) || timeoutMs < RESEARCH_MIN_TIMEOUT_MS || timeoutMs > RESEARCH_MAX_TIMEOUT_MS) {
      throw new RangeError(`web_research timeout_ms must be an integer between ${RESEARCH_MIN_TIMEOUT_MS} and ${RESEARCH_MAX_TIMEOUT_MS}`)
    }
    const finishMs = Math.min(timeoutMs * 0.2, 120_000)
    const budget = new AbortController()
    const signal = AbortSignal.any([callerSignal, budget.signal])
    const hardDeadline = started + timeoutMs
    const timer = setTimeout(() => budget.abort(new ResearchBudgetError()), Math.max(0, hardDeadline - Date.now()))
    timer.unref()
    let child: Awaited<ReturnType<typeof startSdkResearch>> | undefined
    let completed = false
    try {
      const model = await cancellable(resolveResearchModel(this.ctx, request.parent), signal)
      signal.throwIfAborted()
      child = await startSdkResearch(this.ctx, {
        parent: request.parent, query: request.query, route: model.route, signal, callerSignal, auth: model.auth,
        bootstrap: {
          config: this.getConfig(), model: { provider: model.route.provider!, connection: model.connection },
          timeoutMs, finishMs, softDeadline: hardDeadline - finishMs, hardDeadline,
        },
      })
      const result = await cancellable(child.run.result, signal)
      callerSignal.throwIfAborted()
      completed = result.stopReason === 'completed'
      if (!completed && !budget.signal.aborted) throw new Error(`web_research failed (${result.stopReason})`)
      // Idle is not submission: the child flushes its formal tools/result before
      // /finished. This also distinguishes an ordinary final text from a report.
      await cancellable(child.bridge.finished, signal)
    } catch (error) {
      callerSignal.throwIfAborted()
      if (!budget.signal.aborted) throw error
    } finally {
      clearTimeout(timer)
      await child?.dispose()
      callerSignal.throwIfAborted()
    }
    const report = child?.bridge.report()
    if (report !== undefined && (completed || budget.signal.aborted)) return validateResearchReport(report)
    signal.throwIfAborted()
    return validateResearchReport(undefined)
  }

  /** Operations.stop() drains calls; this also cancels direct holders on HMR. */
  dispose(): void { this.shutdown.abort(new Error('web_research executor disposed')) }
}
