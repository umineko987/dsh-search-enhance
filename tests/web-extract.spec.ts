import { afterEach, describe, expect, it, vi } from 'vitest'

import { Config, type Config as SearchEnhanceConfig } from '../src/config.js'
import {
  boundWebExtractResult,
  normalizeWebExtractUrl,
  WEB_EXTRACT_ROUTES,
  WebExtractInfrastructureError,
  WebExtractOrchestrator,
  type WebExtractAdapter,
  type WebExtractAdapterInput,
  type WebExtractAdapterOutcome,
  type WebExtractFormat,
  type WebExtractRoute,
  type WebExtractRouteAttempt,
} from '../src/web-extract/index.js'
import { ProviderError } from '../src/provider-runtime/index.js'

afterEach(() => {
  vi.useRealTimers()
})

function config(overrides: Partial<SearchEnhanceConfig['webExtract']> = {}): SearchEnhanceConfig {
  const base = Config({} as never)
  return {
    ...base,
    webExtract: {
      ...base.webExtract,
      ...overrides,
      tavily: { ...base.webExtract.tavily, ...overrides.tavily },
      firecrawl: { ...base.webExtract.firecrawl, ...overrides.firecrawl },
      smartDirect: { ...base.webExtract.smartDirect, ...overrides.smartDirect },
      direct: { ...base.webExtract.direct, ...overrides.direct },
    },
  }
}

function success(content = 'usable content'): WebExtractAdapterOutcome {
  return {
    state: 'complete',
    result: { content, truncated: false },
  }
}

function adapter(
  route: WebExtractRoute,
  outcome: WebExtractAdapterOutcome | ((input: WebExtractAdapterInput) => Promise<WebExtractAdapterOutcome>),
  options: {
    readonly enabled?: boolean | ((value: SearchEnhanceConfig) => boolean)
    readonly formats?: readonly WebExtractFormat[]
    readonly dispatch?: boolean
  } = {},
): WebExtractAdapter & {
  readonly extract: ReturnType<typeof vi.fn<WebExtractAdapter['extract']>>
} {
  const enabledOption = options.enabled
  const enabled = typeof enabledOption === 'function'
    ? enabledOption
    : (_value: SearchEnhanceConfig) => enabledOption ?? true
  const execute = typeof outcome === 'function' ? outcome : async () => outcome
  return {
    route,
    enabled,
    supports: (format) => options.formats?.includes(format) ?? true,
    extract: vi.fn<WebExtractAdapter['extract']>(async input => {
      if (options.dispatch !== false) input.onDispatch?.()
      return execute(input)
    }),
  }
}

function orchestrator(
  adapters: Partial<Record<WebExtractRoute, WebExtractAdapter>>,
  value = config(),
): WebExtractOrchestrator {
  const make = (route: WebExtractRoute): WebExtractAdapter => adapters[route] ?? adapter(route, { state: 'not_configured' })
  return new WebExtractOrchestrator({
    direct: make('direct'),
    firecrawlScrape: make('firecrawl_scrape'),
    parallelExtract: make('parallel_extract'),
    smartDirect: make('smart_direct'),
    tavilyExtract: make('tavily_extract'),
    getConfig: () => value,
    now: () => 100,
  })
}

function input(
  url = 'https://example.test/article',
  format: WebExtractFormat | undefined = 'markdown',
  signal = new AbortController().signal,
  provider: WebExtractRoute = 'tavily_extract',
) {
  return { format, signal, url, provider }
}

const routeAttempt = (route: WebExtractRoute): WebExtractRouteAttempt => ({
  attempts: 1,
  capability: 'web_extract',
  durationMs: 0,
  outcome: 'success',
  participatedInFallback: false,
  provider: route,
})

describe('web_extract internal contract and fixed orchestrator', () => {
  it.each(WEB_EXTRACT_ROUTES)('executes only the explicitly selected %s Provider', async (provider) => {
    const adapters = Object.fromEntries(WEB_EXTRACT_ROUTES.map(route => [route, adapter(route, success(route))]))
    const result = await orchestrator(adapters).extract(input(undefined, undefined, undefined, provider))
    expect(result.content).toBe(provider)
    expect(result.attempts).toHaveLength(1)
    expect(result.attempts[0]).toMatchObject({ provider, outcome: 'success', participatedInFallback: false })
    for (const route of WEB_EXTRACT_ROUTES) {
      expect(adapters[route]!.extract).toHaveBeenCalledTimes(route === provider ? 1 : 0)
    }
  })

  it.each(['disabled', 'format_unsupported', 'not_configured'] as const)('reports %s without trying another Provider', async (skipReason) => {
    const tavily = adapter('tavily_extract', skipReason === 'not_configured' ? { state: 'not_configured' } : success(), {
      enabled: skipReason !== 'disabled',
      formats: skipReason === 'format_unsupported' ? ['text'] : ['markdown'],
    })
    const direct = adapter('direct', success())
    await expect(orchestrator({ tavily_extract: tavily, direct }).extract(input())).rejects.toMatchObject({
      routeStatuses: [expect.objectContaining({ provider: 'tavily_extract', outcome: 'skipped', skipReason })],
    })
    expect(direct.extract).not.toHaveBeenCalled()
  })

  it('throws a safe selected-Provider error and never dispatches an alternative', async () => {
    const secret = 'Authorization Bearer should-never-escape'
    const tavily = adapter('tavily_extract', async () => { throw new Error(secret) })
    const direct = adapter('direct', success())
    const error = await orchestrator({ tavily_extract: tavily, direct }).extract(input()).catch(error => error)
    expect(error).toBeInstanceOf(WebExtractInfrastructureError)
    expect(error.routeStatuses).toHaveLength(1)
    expect(error.routeStatuses[0]).toMatchObject({ provider: 'tavily_extract', outcome: 'failed', participatedInFallback: false })
    expect(JSON.stringify(error)).not.toContain(secret)
    expect(direct.extract).not.toHaveBeenCalled()
  })

  it('stops the chain on caller cancellation and preserves the caller reason', async () => {
    const controller = new AbortController()
    const reason = new Error('caller stopped web extraction')
    let directCalls = 0
    const first = adapter('tavily_extract', async () => new Promise<WebExtractAdapterOutcome>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
    }))
    const direct = adapter('direct', async () => {
      directCalls += 1
      return success()
    })

    const pending = orchestrator({ tavily_extract: first, direct }).extract(input(
      'https://example.test/article',
      'markdown',
      controller.signal,
    ))
    await vi.waitFor(() => expect(first.extract).toHaveBeenCalled())
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
    expect(directCalls).toBe(0)
  })

  it.each([
    ['ftp://example.test/page', 'scheme'],
    ['https:example.test/page', 'scheme without authority'],
    ['https://user:pass@example.test/page', 'userinfo'],
    ['https://@example.test/page', 'empty userinfo'],
    ['not an absolute URL', 'absolute URL'],
  ])('rejects URL preflight %s (%s)', (url) => {
    expect(() => normalizeWebExtractUrl(url, 200)).toThrow(ProviderError)
  })

  it('accepts a localhost URL at preflight without performing a network request', async () => {
    const direct = adapter('direct', success('fixture stub'))
    const result = await orchestrator({ direct }).extract(input('  http://localhost:65535/fixture  ', undefined, undefined, 'direct'))

    expect(result.requestedUrl).toBe('http://localhost:65535/fixture')
    expect(direct.extract).toHaveBeenCalledTimes(1)
  })

  it('enforces the URL length cap without classifying network categories', () => {
    expect(() => normalizeWebExtractUrl(`https://example.test/${'x'.repeat(20)}`, 20))
      .toThrow(ProviderError)
  })

  it.each([
    ['tavily_extract', 'extracted_content'],
    ['firecrawl_scrape', 'extracted_content'],
    ['smart_direct', 'extracted_content'],
    ['direct', 'direct_http_content'],
    ['parallel_extract', 'extracted_content'],
  ] as const)('maps %s to the truthful %s evidence level', async (route, evidenceLevel) => {
    const adapters: Partial<Record<WebExtractRoute, WebExtractAdapter>> = {}
    for (const candidate of WEB_EXTRACT_ROUTES) {
      adapters[candidate] = adapter(candidate, success(), { enabled: candidate === route })
    }
    const result = await orchestrator(adapters).extract(input(undefined, undefined, undefined, route))
    expect(result.retrievalRoute).toBe(route)
    expect(result.evidenceLevel).toBe(evidenceLevel)
  })

  it('projects direct-only transport facts only from the direct route', async () => {
    const transportFacts = {
      content: 'remote body',
      contentDisposition: 'attachment',
      contentEncoding: 'gzip',
      contentLength: 123,
      contentTransform: 'html_to_text' as const,
      decompressedBodyTruncated: true as const,
      decompressedBytes: 456,
      encodedBodyTruncated: true as const,
      encodedBytes: 78,
      metadataOnlyReason: 'attachment' as const,
      metadataTruncated: true as const,
      outputTruncated: true as const,
      truncated: true,
    }
    const remote = await orchestrator({
      tavily_extract: adapter('tavily_extract', {
        result: transportFacts,
        state: 'complete',
      }),
    }).extract(input())
    expect(remote).toMatchObject({
      evidenceLevel: 'extracted_content',
      retrievalRoute: 'tavily_extract',
      truncated: true,
    })
    for (const field of [
      'contentDisposition',
      'contentEncoding',
      'contentLength',
      'contentTransform',
      'decompressedBodyTruncated',
      'decompressedBytes',
      'encodedBodyTruncated',
      'encodedBytes',
      'metadataOnlyReason',
      'metadataTruncated',
      'outputTruncated',
    ]) {
      expect(field in remote).toBe(false)
    }

    const direct = await orchestrator({
      direct: adapter('direct', {
        result: transportFacts,
        state: 'complete',
      }),
    }).extract(input(undefined, undefined, undefined, 'direct'))
    expect(direct).toMatchObject(transportFacts)
  })

  it('pins route and evidence differences in a keyless canonical-contract snapshot', async () => {
    const results = []
    for (const route of WEB_EXTRACT_ROUTES) {
      const adapters: Partial<Record<WebExtractRoute, WebExtractAdapter>> = {}
      for (const candidate of WEB_EXTRACT_ROUTES) {
        adapters[candidate] = adapter(
          candidate,
          candidate === route ? success(`body from ${route}`) : { state: 'not_configured' },
        )
      }
      results.push(await orchestrator(adapters).extract(input(undefined, undefined, undefined, route)))
    }

    expect(results).toMatchSnapshot()
  })

  it('bounds content separately from the complete Unicode JSON envelope', () => {
    const candidate = {
      author: 'Ada',
      attempts: [routeAttempt('direct')],
      canonicalUrl: 'https://example.test/canonical',
      content: 'A界🙂Z',
      evidenceLevel: 'direct_http_content' as const,
      format: 'text' as const,
      requestedUrl: 'https://example.test/article',
      retrievalRoute: 'direct' as const,
      truncated: false,
    }
    const broad = boundWebExtractResult(candidate, 100, 100_000)
    expect(broad.truncated).toBe(false)
    const exactBytes = Buffer.byteLength(JSON.stringify(broad), 'utf8')
    const exact = boundWebExtractResult(candidate, 100, exactBytes)
    expect(exact.content).toBe(candidate.content)
    expect(exact.truncated).toBe(false)

    const over = boundWebExtractResult(candidate, 100, exactBytes - 1)
    expect(over.truncated).toBe(true)
    expect(over.content).not.toBe('')
    expect(Array.from(over.content).length).toBeLessThan(Array.from(candidate.content).length)
    expect(Buffer.byteLength(JSON.stringify(over), 'utf8')).toBeLessThanOrEqual(exactBytes - 1)

    const unicodeLimited = boundWebExtractResult(candidate, 2, 100_000)
    expect(unicodeLimited.content).toBe('A界')
    expect(unicodeLimited.truncated).toBe(true)
    expect(() => boundWebExtractResult(candidate, 100, 1)).toThrow()
  })

  it('applies the total cooperative timeout, waits for quiescence, and starts no next route', async () => {
    vi.useFakeTimers()
    let quiesced = false
    const first = adapter('tavily_extract', async ({ signal }) => new Promise<WebExtractAdapterOutcome>((resolve) => {
      signal.addEventListener('abort', () => {
        queueMicrotask(() => {
          quiesced = true
          resolve({ state: 'unavailable' })
        })
      }, { once: true })
    }))
    const direct = adapter('direct', success())
    const operation = orchestrator({ tavily_extract: first, direct }, config({ timeoutMs: 50 })).extract(input())

    const rejection = expect(operation).rejects.toMatchObject({ kind: 'timeout' })
    await vi.advanceTimersByTimeAsync(50)
    await rejection
    expect(quiesced).toBe(true)
    expect(direct.extract).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('fails closed when the truthful envelope cannot fit instead of returning empty success', async () => {
    const first = adapter('tavily_extract', success('content that cannot fit'))
    const request = orchestrator(
      { tavily_extract: first },
      config({ maxOutputBytes: 1 }),
    ).extract(input())

    await expect(request).rejects.toBeInstanceOf(WebExtractInfrastructureError)
    try {
      await request
    } catch (error) {
      const failure = error as WebExtractInfrastructureError
      expect(failure.routeStatuses[0]).toMatchObject({
        errorKind: 'budget_exceeded',
        outcome: 'failed',
        provider: 'tavily_extract',
      })
    }
  })

  it('validates the new deployment-only web-extract boundaries at load time', () => {
    expect(Config({} as never).webExtract).toMatchObject({
      maxContentCharacters: 50_000,
      maxOutputBytes: 256 * 1024,
      tavily: { enabled: true },
      firecrawl: { maxEmptyAttempts: 3 },
      direct: {
        enabled: true,
        maxHeaderBytes: 64 * 1024,
        maxHtmlScanBytes: 512 * 1024,
        maxRedirects: 5,
        maxRetries: 2,
      },
    })
    expect(() => Config({ webExtract: { maxOutputBytes: 0 } } as never)).toThrow()
    expect(() => Config({ webExtract: { tavily: { maxResponseBytes: 0 } } } as never)).toThrow()
    expect(() => Config({ webExtract: { firecrawl: { maxEmptyAttempts: 0 } } } as never)).toThrow()
    expect(() => Config({ webExtract: { direct: { maxHeaderBytes: 0 } } } as never)).toThrow()
    expect(() => Config({ webExtract: { direct: { maxHtmlScanBytes: 0 } } } as never)).toThrow()
    expect(() => Config({ webExtract: { direct: { maxRetries: -1 } } } as never)).toThrow()
    expect(() => Config({ webExtract: { direct: { maxRedirects: 21 } } } as never)).toThrow()
  })
})
