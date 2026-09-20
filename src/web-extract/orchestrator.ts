import type { Config } from '../config.js'
import {
  createProviderAttemptRecord,
  isAbortError,
  isProviderError,
  OutputLimitError,
  ProviderError,
  runWithTimeout,
  throwIfAborted,
  type ProviderAttemptRecord,
} from '../provider-runtime/index.js'
import { boundWebExtractResult } from './bounds.js'
import { normalizeWebExtractUrl } from './url.js'
import {
  DIRECT_CONTENT_TRANSFORMS,
  DIRECT_METADATA_ONLY_REASONS,
  evidenceLevelForRoute,
  isWebExtractFormat,
  WebExtractInfrastructureError,
  type WebExtractAdapter,
  type WebExtractAdapterResult,
  type WebExtractFormat,
  type WebExtractInput,
  type WebExtractOrchestratorDependencies,
  type WebExtractResult,
  type WebExtractRoute,
  type WebExtractRouteAttempt,
} from './types.js'

const ORCHESTRATOR_PROVIDER = 'web-extract-orchestrator'

function clockValue(now: () => number): number {
  const value = now()
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('web_extract clock must return a finite non-negative value')
  }
  return value
}

function duration(startedAt: number, now: () => number): number {
  return Math.max(0, clockValue(now) - startedAt)
}

function safeProviderError(error: unknown, route: WebExtractRoute): ProviderError {
  if (isProviderError(error)) return error
  return new ProviderError({
    capability: 'web_extract',
    cause: error,
    kind: 'unknown',
    provider: route,
  })
}

function routeAttempt(
  route: WebExtractRoute,
  input: {
    readonly outcome: ProviderAttemptRecord['outcome']
    readonly durationMs: number
    readonly attempts: number
    readonly participatedInFallback: boolean
    readonly error?: unknown
    readonly skipReason?: Parameters<typeof createProviderAttemptRecord>[0]['skipReason']
  },
): WebExtractRouteAttempt {
  const record = createProviderAttemptRecord({
    attempts: input.attempts,
    capability: 'web_extract',
    durationMs: input.durationMs,
    ...(input.error === undefined ? {} : { error: input.error }),
    outcome: input.outcome,
    participatedInFallback: input.participatedInFallback,
    provider: route,
    ...(input.skipReason === undefined ? {} : { skipReason: input.skipReason }),
  })
  return Object.freeze({ ...record, capability: 'web_extract', provider: route })
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function boundedRemoteUrl(value: unknown, maximumCharacters: number): string | undefined {
  const candidate = nonEmptyString(value)
  if (candidate === undefined) return undefined
  try {
    const parsed = new URL(candidate)
    const authority = /^https?:\/\/([^/?#]*)/i.exec(candidate)?.[1]
    if (
      authority === undefined
      || authority.includes('@')
      || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username.length > 0
      || parsed.password.length > 0
      || Array.from(candidate).length > maximumCharacters
    ) return undefined
    return candidate
  } catch {
    return undefined
  }
}

function safeStatusCode(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 100
    && value <= 599
    ? value
    : undefined
}

function safeNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : undefined
}

function trueFlag(value: unknown): true | undefined {
  return value === true ? true : undefined
}

/** Keep only explicit, scalar metadata from an adapter response. */
function sanitizeAdapterResult(
  result: WebExtractAdapterResult,
  maximumUrlCharacters: number,
  route: WebExtractRoute,
): WebExtractAdapterResult {
  if (typeof result.content !== 'string' || result.content.trim().length === 0) {
    throw new ProviderError({
      capability: 'web_extract',
      kind: 'unavailable',
      provider: ORCHESTRATOR_PROVIDER,
    })
  }
  if (typeof result.truncated !== 'boolean') {
    throw new ProviderError({
      capability: 'web_extract',
      kind: 'invalid_response',
      provider: ORCHESTRATOR_PROVIDER,
    })
  }
  const finalUrl = boundedRemoteUrl(result.finalUrl, maximumUrlCharacters)
  const canonicalUrl = boundedRemoteUrl(result.canonicalUrl, maximumUrlCharacters)
  const contentType = nonEmptyString(result.contentType)
  const contentDisposition = nonEmptyString(result.contentDisposition)
  const contentEncoding = nonEmptyString(result.contentEncoding)
  const title = nonEmptyString(result.title)
  const author = nonEmptyString(result.author)
  const publishedAt = nonEmptyString(result.publishedAt)
  const statusCode = safeStatusCode(result.statusCode)
  const direct = route === 'direct'
  const local = route === 'smart_direct' || direct
  const contentLength = local ? safeNonNegativeInteger(result.contentLength) : undefined
  const encodedBytes = local ? safeNonNegativeInteger(result.encodedBytes) : undefined
  const decompressedBytes = local ? safeNonNegativeInteger(result.decompressedBytes) : undefined
  const metadataOnlyReason = direct && DIRECT_METADATA_ONLY_REASONS.includes(
    result.metadataOnlyReason as (typeof DIRECT_METADATA_ONLY_REASONS)[number],
  ) ? result.metadataOnlyReason : undefined
  const contentTransform = direct && DIRECT_CONTENT_TRANSFORMS.includes(
    result.contentTransform as (typeof DIRECT_CONTENT_TRANSFORMS)[number],
  ) ? result.contentTransform : undefined
  const encodedBodyTruncated = direct ? trueFlag(result.encodedBodyTruncated) : undefined
  const decompressedBodyTruncated = direct ? trueFlag(result.decompressedBodyTruncated) : undefined
  const outputTruncated = local ? trueFlag(result.outputTruncated) : undefined
  const metadataTruncated = local ? trueFlag(result.metadataTruncated) : undefined
  return {
    content: result.content.trim(),
    truncated: result.truncated,
    ...(finalUrl === undefined ? {} : { finalUrl }),
    ...(title === undefined ? {} : { title }),
    ...(author === undefined ? {} : { author }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
    ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
    ...(contentType === undefined ? {} : { contentType }),
    ...(contentLength === undefined ? {} : { contentLength }),
    ...(local && contentDisposition !== undefined ? { contentDisposition } : {}),
    ...(local && contentEncoding !== undefined ? { contentEncoding } : {}),
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(encodedBytes === undefined ? {} : { encodedBytes }),
    ...(decompressedBytes === undefined ? {} : { decompressedBytes }),
    ...(metadataOnlyReason === undefined ? {} : { metadataOnlyReason }),
    ...(contentTransform === undefined ? {} : { contentTransform }),
    ...(encodedBodyTruncated === undefined ? {} : { encodedBodyTruncated }),
    ...(decompressedBodyTruncated === undefined ? {} : { decompressedBodyTruncated }),
    ...(outputTruncated === undefined ? {} : { outputTruncated }),
    ...(metadataTruncated === undefined ? {} : { metadataTruncated }),
  }
}

function freezeAttempts(attempts: readonly WebExtractRouteAttempt[]): readonly WebExtractRouteAttempt[] {
  return Object.freeze(attempts.map(attempt => Object.freeze({ ...attempt })))
}

/** Execute one user-enabled extraction Provider, without automatic fallback. */
export class WebExtractOrchestrator {
  private readonly adapters: readonly WebExtractAdapter[]
  private readonly getConfig: (() => Config) | undefined
  private readonly now: () => number

  constructor(dependencies: WebExtractOrchestratorDependencies) {
    this.adapters = Object.freeze([
      dependencies.tavilyExtract,
      dependencies.firecrawlScrape,
      dependencies.smartDirect,
      dependencies.direct,
    ])
    this.getConfig = dependencies.getConfig
    this.now = dependencies.now ?? Date.now
  }

  /** Execute one bounded extraction operation under the configured total deadline. */
  async extract(input: WebExtractInput): Promise<Readonly<WebExtractResult>> {
    const config = input.config ?? this.getConfig?.()
    if (config === undefined) {
      throw new ProviderError({
        capability: 'web_extract',
        kind: 'configuration',
        provider: ORCHESTRATOR_PROVIDER,
      })
    }
    const adapter = this.adapters.find(candidate => candidate.route === input.provider)
    if (adapter === undefined) {
      throw new ProviderError({ capability: 'web_extract', kind: 'invalid_request', provider: ORCHESTRATOR_PROVIDER })
    }
    const format = input.format ?? 'markdown'
    if (!isWebExtractFormat(format)) {
      throw new ProviderError({
        capability: 'web_extract',
        kind: 'invalid_request',
        provider: ORCHESTRATOR_PROVIDER,
      })
    }

    let requestedUrl: string
    try {
      requestedUrl = normalizeWebExtractUrl(input.url, config.webExtract.maxUrlCharacters)
    } catch (error) {
      if (isProviderError(error)) throw error
      throw new ProviderError({
        capability: 'web_extract',
        cause: error,
        kind: 'invalid_request',
        provider: ORCHESTRATOR_PROVIDER,
      })
    }

    return runWithTimeout(
      signal => this.execute({ adapter, config, format, requestedUrl, signal }),
      {
        capability: 'web_extract',
        provider: ORCHESTRATOR_PROVIDER,
        signal: input.signal,
        timeoutMs: config.webExtract.timeoutMs,
      },
    )
  }

  private async execute(input: {
    readonly adapter: WebExtractAdapter
    readonly config: Config
    readonly format: WebExtractFormat
    readonly requestedUrl: string
    readonly signal: AbortSignal
  }): Promise<Readonly<WebExtractResult>> {
    const { adapter } = input
    const route = adapter.route
    const startedAt = clockValue(this.now)
    let dispatches = 0
    const skipped = (skipReason: 'disabled' | 'format_unsupported' | 'not_configured'): never => {
      throw new WebExtractInfrastructureError([routeAttempt(route, {
        attempts: 0,
        durationMs: duration(startedAt, this.now),
        outcome: 'skipped',
        participatedInFallback: false,
        skipReason,
      })])
    }
    try {
      throwIfAborted(input.signal)
      if (!adapter.enabled(input.config)) skipped('disabled')
      if (!adapter.supports(input.format)) skipped('format_unsupported')
      const outcome = await adapter.extract({
        config: input.config,
        format: input.format,
        onDispatch: () => { dispatches += 1 },
        signal: input.signal,
        url: input.requestedUrl,
      })
      throwIfAborted(input.signal)
      if (outcome.state === 'not_configured') skipped('not_configured')
      if (outcome.state !== 'complete') {
        throw new ProviderError({
          capability: 'web_extract',
          kind: outcome.state === 'unavailable' ? 'unavailable' : 'invalid_response',
          provider: route,
        })
      }
      const result = sanitizeAdapterResult(outcome.result, input.config.webExtract.maxUrlCharacters, route)
      return boundWebExtractResult({
        ...result,
        requestedUrl: input.requestedUrl,
        format: input.format,
        retrievalRoute: route,
        evidenceLevel: evidenceLevelForRoute(route),
        attempts: freezeAttempts([routeAttempt(route, {
          attempts: Math.max(1, dispatches),
          durationMs: duration(startedAt, this.now),
          outcome: 'success',
          participatedInFallback: false,
        })]),
      }, input.config.webExtract.maxContentCharacters, input.config.webExtract.maxOutputBytes)
    } catch (error) {
      throwIfAborted(input.signal)
      if (isAbortError(error) || error instanceof WebExtractInfrastructureError) throw error
      throw new WebExtractInfrastructureError([routeAttempt(route, {
        attempts: Math.max(1, dispatches),
        durationMs: duration(startedAt, this.now),
        error: error instanceof OutputLimitError ? webExtractBudgetError(error) : safeProviderError(error, route),
        outcome: 'failed',
        participatedInFallback: false,
      })])
    }
  }
}

/** Convert an output-boundary failure to the common safe Provider category. */
export function webExtractBudgetError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error
  return new ProviderError({
    capability: 'web_extract',
    cause: error instanceof OutputLimitError ? error : undefined,
    kind: 'budget_exceeded',
    provider: ORCHESTRATOR_PROVIDER,
  })
}
