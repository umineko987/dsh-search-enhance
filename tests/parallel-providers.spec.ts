import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it, vi } from 'vitest'

import { Config } from '../src/config.js'
import { ProviderError } from '../src/provider-runtime/index.js'
import {
  ParallelExtractProvider,
  ParallelSearchProvider,
  parseParallelExtractResponse,
  parseParallelSearchSources,
} from '../src/providers/index.js'
import { WebExtractOrchestrator, WebExtractInfrastructureError, type WebExtractAdapter, type WebExtractRoute } from '../src/web-extract/index.js'
import { projectWebExtractOutput } from '../src/tools/web-extract.js'
import { renderWebExtractText } from '../src/presentation/render.js'

function config(extra: Record<string, unknown> = {}) {
  return Config({
    retry: { maxAttempts: 1 },
    webExtract: { parallel: { enabled: true } },
    ...extra,
  } as never)
}

function credentials(values: Array<string | undefined>) {
  const queue = [...values]
  return {
    describe: vi.fn<CredentialProvider['describe']>(async () => ({ configured: values[0] !== undefined, writable: true })),
    resolve: vi.fn<CredentialProvider['resolve']>(async () => {
      const value = queue.shift()
      return value === undefined ? undefined : { source: 'test', value }
    }),
  }
}

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const signal = () => new AbortController().signal
const url = 'https://example.test/article'

function extractor(parallelExtract: WebExtractAdapter, value = config()) {
  const unused = (route: WebExtractRoute): WebExtractAdapter => ({
    route, enabled: () => true, supports: () => true,
    extract: vi.fn<WebExtractAdapter['extract']>(async () => ({ state: 'unavailable' })),
  })
  const other = {
    tavilyExtract: unused('tavily_extract'), firecrawlScrape: unused('firecrawl_scrape'),
    smartDirect: unused('smart_direct'), direct: unused('direct'),
  }
  return { other, orchestrator: new WebExtractOrchestrator({ ...other, parallelExtract, getConfig: () => value }) }
}

describe('Parallel Search adapter', () => {
  it('uses the v1 protocol, clamps API limits, and resolves the shared credential for every request', async () => {
    const credential = credentials(['first-key', 'rotated-key'])
    const fetchMock = vi.fn(async () => json({ results: [{
      url, title: ' Article ', publish_date: '2026-04-01', excerpts: [' First ', 'Second'],
    }, { url: 'file:///private' }] }))
    const provider = new ParallelSearchProvider({ credentials: credential, fetch: fetchMock })
    const value = config({ providers: { parallel: { mode: 'advanced' } } })
    expect(await provider.configured(value)).toBe(true)
    expect(credential.resolve).not.toHaveBeenCalled()

    const query = '关于这个项目的最新资料'.repeat(30)
    const result = await provider.search({ config: value, query, limit: 100, signal: signal() })
    await provider.search({ config: value, query: 'follow up', limit: 1, signal: signal() })
    const [endpoint, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(endpoint).toBe('https://api.parallel.ai/v1/search')
    expect(request).toMatchObject({ method: 'POST', redirect: 'manual', headers: { 'x-api-key': 'first-key' } })
    expect(JSON.parse(String(request.body))).toEqual({
      objective: query, search_queries: [Array.from(query).slice(0, 200).join('')], mode: 'advanced',
      advanced_settings: { max_results: 20 }, max_chars_total: value.retention.providerResultMaxBytes / 4,
    })
    expect((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'x-api-key': 'rotated-key' })
    expect(credential.resolve.mock.calls.map(call => call[0])).toEqual(['PARALLEL_API_KEY', 'PARALLEL_API_KEY'])
    expect(result).toMatchObject({ state: 'complete', result: { returnedSources: 1, sources: [{
      url, provider: 'parallel', title: 'Article', publishedAt: '2026-04-01', snippet: 'First\n\nSecond',
    }] } })
    expect(JSON.stringify(result)).not.toContain('key')
  })

  it('keeps the existing source-count and canonical byte limits', async () => {
    const rows = Array.from({ length: 4 }, (_, index) => ({ url: `${url}/${index}`, excerpts: ['😀'.repeat(120)] }))
    const fetchMock = vi.fn(async () => json({ results: rows }))
    const provider = new ParallelSearchProvider({ credentials: credentials(['key', 'key']), fetch: fetchMock })
    const count = await provider.search({ config: config(), query: 'query', limit: 2, signal: signal() })
    expect(count).toMatchObject({ state: 'complete', result: { totalSources: 4, returnedSources: 2, truncated: true } })
    const bytes = await provider.search({
      config: config({ retention: { providerResultMaxBytes: 750 } }), query: 'query', limit: 4, signal: signal(),
    })
    expect(bytes.state).toBe('complete')
    if (bytes.state !== 'complete') throw new Error('expected sources')
    expect(bytes.result.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(bytes.result))).toBeLessThanOrEqual(750)
  })

  it('rejects malformed responses without copying their contents', () => {
    expect(parseParallelSearchSources('{"results":[]}', 8192)).toEqual([])
    expect(() => parseParallelSearchSources('{"secret":"key"}', 8192)).toThrow(ProviderError)
    expect(() => parseParallelSearchSources('not-json-secret', 8192)).toThrow(ProviderError)
  })
})

describe('Parallel Extract adapter', () => {
  it('requests bounded full Markdown with explicit cache policy, without claiming raw HTTP metadata', async () => {
    const credential = credentials(['extract-key'])
    const fetchMock = vi.fn(async () => json({ results: [{
      url, title: 'Article', publish_date: '2026-04-01', full_content: '😀正文结束',
      excerpts: ['not a page body'], status_code: 200, final_url: 'https://other.test', content_type: 'text/html',
    }] }))
    const value = config({ webExtract: { parallel: { enabled: true, maxContentCharacters: 3 } } })
    const provider = new ParallelExtractProvider({ credentials: credential, fetch: fetchMock })
    const { orchestrator, other } = extractor(provider, value)
    const result = await orchestrator.extract({ url, provider: 'parallel_extract', signal: signal() })
    const [endpoint, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(endpoint).toBe('https://api.parallel.ai/v1/extract')
    expect(request).toMatchObject({ method: 'POST', redirect: 'manual', headers: { 'x-api-key': 'extract-key' } })
    expect(JSON.parse(String(request.body))).toEqual({
      urls: [url], advanced_settings: {
        fetch_policy: { max_age_seconds: 600, disable_cache_fallback: true },
        full_content: { max_chars_per_result: 4 },
      },
    })
    expect(credential.resolve.mock.calls[0]?.[0]).toBe('PARALLEL_API_KEY')
    expect(result).toMatchObject({
      content: '😀正文', format: 'markdown', title: 'Article', publishedAt: '2026-04-01',
      retrievalRoute: 'parallel_extract', evidenceLevel: 'extracted_content', truncated: true,
    })
    expect(result).not.toHaveProperty('statusCode')
    expect(result).not.toHaveProperty('finalUrl')
    expect(result).not.toHaveProperty('contentType')
    expect(renderWebExtractText(projectWebExtractOutput(result, value))).toContain('up to 10 minutes old')
    for (const adapter of Object.values(other)) expect(adapter.extract).not.toHaveBeenCalled()
  })

  it('does not dispatch unsupported formats or disabled routes, and never falls back on failure', async () => {
    const fetchMock = vi.fn(async () => json({ results: [], errors: [{ content: 'secret remote failure' }] }))
    const credential = credentials(['key'])
    const provider = new ParallelExtractProvider({ credentials: credential, fetch: fetchMock })
    expect(provider.supports('markdown')).toBe(true)
    for (const format of ['text', 'html', 'raw', 'json'] as const) expect(provider.supports(format)).toBe(false)
    const { orchestrator, other } = extractor(provider)
    await expect(orchestrator.extract({ url, provider: 'parallel_extract', format: 'html', signal: signal() }))
      .rejects.toBeInstanceOf(WebExtractInfrastructureError)
    await expect(extractor(provider, Config({} as never)).orchestrator.extract({ url, provider: 'parallel_extract', signal: signal() }))
      .rejects.toBeInstanceOf(WebExtractInfrastructureError)
    expect(credential.resolve).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(orchestrator.extract({ url, provider: 'parallel_extract', signal: signal() })).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    for (const adapter of Object.values(other)) expect(adapter.extract).not.toHaveBeenCalled()
  })

  it('never substitutes excerpts, error text, or anti-bot pages for full content', () => {
    expect(parseParallelExtractResponse(JSON.stringify({ results: [{ excerpts: ['excerpt only'] }] }), 100)).toBeUndefined()
    expect(parseParallelExtractResponse(JSON.stringify({ results: [], errors: [{ content: 'private error' }] }), 100)).toBeUndefined()
    expect(() => parseParallelExtractResponse('{}', 100)).toThrow(ProviderError)
    expect(() => parseParallelExtractResponse(JSON.stringify({ results: [{
      full_content: '<script src="/cdn-cgi/challenge-platform/script"></script>',
    }] }), 100)).toThrow(ProviderError)
  })
})

it.each(['search', 'extract'] as const)('Parallel %s skips missing credentials and respects caller cancellation', async kind => {
  const fetchMock = vi.fn(async () => json({ results: [] }))
  const credential = credentials([undefined])
  const dependencies = { credentials: credential, fetch: fetchMock }
  const provider = kind === 'search' ? new ParallelSearchProvider(dependencies) : new ParallelExtractProvider(dependencies)
  const input = { config: config(), query: 'query', limit: 1, url, format: 'markdown' as const, signal: signal() }
  const run = (inputSignal: AbortSignal) => kind === 'search'
    ? (provider as ParallelSearchProvider).search({ ...input, signal: inputSignal })
    : (provider as ParallelExtractProvider).extract({ ...input, signal: inputSignal })
  expect(await run(input.signal)).toEqual({ state: 'not_configured' })
  const abort = new AbortController()
  abort.abort()
  await expect(run(abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(credential.resolve).toHaveBeenCalledTimes(1)
  expect(fetchMock).not.toHaveBeenCalled()
})
