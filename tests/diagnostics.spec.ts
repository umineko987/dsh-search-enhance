import { describe, expect, it, vi } from 'vitest'

import { Config, type Config as SearchEnhanceConfig } from '../src/config.js'
import {
  Context7ResolveDiagnosticProbe,
  DIAGNOSTIC_CONTEXT7_LIBRARY_NAME,
  DIAGNOSTIC_CONTEXT7_QUERY,
  DIAGNOSTIC_RESULT_LIMIT,
  DIAGNOSTIC_SEARCH_QUERY,
  SearchApiModelListDiagnosticProbe,
  SearchDiagnostics,
  SourceSearchDiagnosticProbe,
  diagnosticProbeConfig,
  type DiagnosticCredentialDescriber,
  type DiagnosticProbe,
  type DiagnosticProbeInput,
  type DiagnosticProbeResult,
  type SearchDiagnosticReport,
} from '../src/diagnostics/index.js'
import { ProviderError } from '../src/provider-runtime/index.js'

function config(overrides: Partial<SearchEnhanceConfig> = {}): SearchEnhanceConfig {
  const base = Config({} as never)
  return {
    ...base,
    ...overrides,
    diagnostics: { ...base.diagnostics, ...overrides.diagnostics },
    supplementalSearch: { ...base.supplementalSearch, tavily: true, firecrawl: true, ...overrides.supplementalSearch },
    providers: {
      ...base.providers,
      ...overrides.providers,
    },
    webExtract: {
      ...base.webExtract,
      ...overrides.webExtract,
    },
  }
}

function credentials(
  configured = true,
  describe: DiagnosticCredentialDescriber['describe'] | undefined = undefined,
): DiagnosticCredentialDescriber {
  return {
    describe: describe ?? (async () => ({ configured, writable: false })),
  }
}

function probe(
  capability: DiagnosticProbe['capability'],
  provider: DiagnosticProbe['provider'],
  execute: (input: DiagnosticProbeInput) => Promise<Readonly<DiagnosticProbeResult>> = async input => {
    input.onDispatch()
    return { state: 'complete' }
  },
): DiagnosticProbe {
  return { capability, provider, probe: execute }
}

const networkProbeSet = (): readonly DiagnosticProbe[] => [
  probe('main_search', 'search_api'),
  probe('main_search', 'exa'),
  probe('main_search', 'tavily_search'),
  probe('main_search', 'firecrawl_search'),
  probe('docs_search', 'context7'),
  probe('docs_search', 'exa'),
]


describe('search diagnostics status and probe orchestration', () => {
  it('keeps show network-free, calls only Credentials.describe, and returns no successful attempts', async () => {
    const describe = vi.fn(async () => ({ configured: true, writable: false }))
    const forbiddenProbe = vi.fn(async () => {
      throw new Error('show dispatched a probe')
    })
    const fetch = vi.spyOn(globalThis, 'fetch')
    const reporter = new SearchDiagnostics({
      credentials: credentials(true, describe),
      probes: [probe('main_search', 'search_api', forbiddenProbe)],
    })

    const value = await reporter.show({ config: config(), signal: new AbortController().signal })

    expect(describe).toHaveBeenCalledTimes(5)
    expect(forbiddenProbe).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(value).toMatchObject({ action: 'show', tested: false, fallbackUsed: false })
    expect(value.providerAttempts).toEqual([])
    expect(value.providersUsed).toEqual([])
    expect(value.capabilityStatus.map(item => item.capability)).toEqual([
      'main_search',
      'docs_search',
      'web_extract',
      'site_map',
    ])
    expect(value.minimumProfile).toEqual({ profile: 'standard', satisfied: false })
  })

  it('does not project local-route proxy settings into diagnostics', async () => {
    const base = Config({} as never)
    const value = config({
      webExtract: {
        ...base.webExtract,
        smartDirect: {
          ...base.webExtract.smartDirect,
          proxyUrl: 'http://smart-proxy.private.invalid:8080',
        },
        direct: {
          ...base.webExtract.direct,
          proxyUrl: 'http://direct-proxy.private.invalid:8081',
        },
      },
    })
    const reporter = new SearchDiagnostics({ credentials: credentials(), probes: [] })
    const report = await reporter.show({ config: value, signal: new AbortController().signal })
    const visible = JSON.stringify(report)

    expect(report.configuration).toMatchObject({ smartDirectEnabled: true, directEnabled: true })
    expect(visible).not.toMatch(/proxyUrl|proxy_url|smart-proxy|direct-proxy|private\.invalid/i)
  })

  it('maps describe exceptions to safe unavailable state without retaining causes, refs, endpoints, or values', async () => {
    const secret = 'diagnostic-secret-value'
    const ref = 'TOP_SECRET_DIAGNOSTIC_REF'
    const value = config({ searchApi: { ...Config({} as never).searchApi, credentialRef: ref as never } })
    const reporter = new SearchDiagnostics({
      credentials: credentials(false, async credential => {
        if (String(credential) === ref) throw new Error(`failure ${secret} private-path-sentinel ${ref}`)
        return { configured: false, writable: false }
      }),
      probes: [],
    })

    const report = await reporter.show({ config: value, signal: new AbortController().signal })
    const text = JSON.stringify(report)
    expect(report.capabilityStatus[0]?.providers[0]).toEqual({
      provider: 'search_api',
      state: 'unavailable',
    })
    expect(report.warnings).toContainEqual({ code: 'configuration_unavailable', count: 1 })
    expect(text).not.toContain(secret)
    expect(text).not.toContain(ref)
    expect(text).not.toContain('private-path-sentinel')
    expect(text).not.toContain(value.searchApi.baseUrl)
  })

  it.each([false, true])('probes each supported selected route once (supplemental Exa: %s)', async (exa) => {
    const starts: string[] = []
    const probes = networkProbeSet().map(item => probe(
      item.capability,
      item.provider,
      async input => {
        starts.push(`${item.capability}/${item.provider}`)
        input.onDispatch()
        return { state: 'complete' }
      },
    ))
    let tick = 100
    const reporter = new SearchDiagnostics({
      credentials: credentials(),
      probes,
      now: () => tick++,
    })

    const report = await reporter.test({
      config: config({ supplementalSearch: { ...config().supplementalSearch, exa } }),
      signal: new AbortController().signal,
    })

    expect(starts).toEqual([
      'main_search/search_api',
      ...(exa ? ['main_search/exa'] : []),
      'main_search/tavily_search',
      'main_search/firecrawl_search',
      'docs_search/context7',
      'docs_search/exa',
    ])
    expect(report.providerAttempts.map(item => `${item.capability}/${item.provider}`)).toEqual([
      'main_search/search_api',
      'main_search/exa',
      'main_search/tavily_search',
      'main_search/firecrawl_search',
      'docs_search/context7',
      'docs_search/exa',
      'web_extract/tavily_extract',
      'web_extract/firecrawl_scrape',
      'web_extract/smart_direct',
      'web_extract/direct',
      'site_map/tavily_map',
    ])
    expect(report.providerAttempts.filter(item => item.outcome === 'success')).toHaveLength(exa ? 6 : 5)
    expect(report.providerAttempts.find(item => item.capability === 'main_search' && item.provider === 'exa'))
      .toMatchObject(exa ? { outcome: 'success', attempts: 1 } : { outcome: 'disabled', attempts: 0 })
    expect(report.providerAttempts.filter(item => item.capability === 'web_extract' || item.capability === 'site_map')
      .every(item => item.outcome === 'unsupported')).toBe(true)
    expect(report.providersUsed).toEqual(['search_api', 'tavily_search', 'firecrawl_search', 'context7', 'exa'])
    expect(report.fallbackUsed).toBe(false)
    expect(report.warnings).toContainEqual({ code: 'unsupported', count: 5 })
  })

  it('reports failed, not-configured, disabled, unsupported, and unavailable routes without raw errors', async () => {
    const secret = 'raw-provider-secret'
    const describe = vi.fn(async (ref: unknown) => ({
      configured: !String(ref).includes('EXA'),
      writable: false,
    }))
    const reporter = new SearchDiagnostics({
      credentials: credentials(true, describe as never),
      probes: [
        probe('main_search', 'search_api', async input => {
          input.onDispatch()
          throw new ProviderError({
            capability: 'model_list',
            kind: 'rate_limited',
            provider: `provider-${secret}`,
          })
        }),
      ],
    })
    const value = config({
      supplementalSearch: { exa: false, tavily: false, firecrawl: false, maxSourcesPerProvider: 5 },
    })

    const report = await reporter.test({ config: value, signal: new AbortController().signal })
    expect(report.providerAttempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'search_api', outcome: 'failed', errorKind: 'rate_limited' }),
      expect.objectContaining({ provider: 'tavily_search', outcome: 'disabled', attempts: 0 }),
      expect.objectContaining({ provider: 'firecrawl_search', outcome: 'disabled', attempts: 0 }),
      expect.objectContaining({ provider: 'exa', outcome: 'not_configured', attempts: 0 }),
      expect.objectContaining({ provider: 'smart_direct', outcome: 'unsupported', attempts: 0 }),
      expect.objectContaining({ provider: 'tavily_map', outcome: 'unsupported', attempts: 0 }),
    ]))
    expect(JSON.stringify(report)).not.toContain(secret)
  })

  it('fails a probe that exceeds its fixed dispatch-attempt budget', async () => {
    const reporter = new SearchDiagnostics({
      credentials: credentials(),
      probes: [probe('main_search', 'search_api', async input => {
        input.onDispatch()
        input.onDispatch()
        return { state: 'complete' }
      })],
    })
    const report = await reporter.test({ config: config(), signal: new AbortController().signal })
    expect(report.providerAttempts[0]).toMatchObject({
      provider: 'search_api',
      outcome: 'failed',
      attempts: 2,
      errorKind: 'budget_exceeded',
    })
  })

  it('rethrows the original caller AbortError only after all owned probe work drains', async () => {
    const controller = new AbortController()
    let drained = false
    let markStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const reporter = new SearchDiagnostics({
      credentials: credentials(),
      probes: [probe('main_search', 'search_api', input => new Promise((_resolve, reject) => {
        input.onDispatch()
        markStarted?.()
        input.signal.addEventListener('abort', () => {
          setTimeout(() => {
            drained = true
            reject(input.signal.reason)
          }, 5)
        }, { once: true })
      }))],
    })
    const reason = new DOMException('caller cancelled', 'AbortError')
    const pending = reporter.test({ config: config(), signal: controller.signal })
    await started
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
    expect(drained).toBe(true)
  })

  it('maps the unified deadline to a safe timeout only after probe work drains', async () => {
    let drained = false
    const reporter = new SearchDiagnostics({
      credentials: credentials(),
      probes: [probe('main_search', 'search_api', input => new Promise((_resolve, reject) => {
        input.onDispatch()
        input.signal.addEventListener('abort', () => {
          setTimeout(() => {
            drained = true
            reject(input.signal.reason)
          }, 5)
        }, { once: true })
      }))],
    })
    const value = config({ diagnostics: { ...config().diagnostics, timeoutMs: 10 } })

    await expect(reporter.test({ config: value, signal: new AbortController().signal }))
      .rejects.toMatchObject({ kind: 'timeout', provider: 'search-diagnostics' })
    expect(drained).toBe(true)
  })

  it('clamps every public probe resource to the independent diagnostics budget', () => {
    const value = config({
      retry: {
        ...Config({} as never).retry,
        maxAttempts: 3,
        baseDelayMs: 20_000,
        maxDelayMs: 30_000,
        maxTotalDelayMs: 40_000,
      },
      diagnostics: {
        ...Config({} as never).diagnostics,
        timeoutMs: 10_000,
        maxProbeAttempts: 2,
        maxResponseBytes: 32_000,
        maxResultBytes: 24_000,
      },
    })
    const bounded = diagnosticProbeConfig(value)

    expect(bounded.retry).toMatchObject({
      maxAttempts: 2,
      baseDelayMs: 10_000,
      maxDelayMs: 10_000,
      maxTotalDelayMs: 10_000,
    })
    expect(bounded.searchApi.timeoutMs).toBe(10_000)
    expect(Object.values(bounded.providers).every(provider => provider.timeoutMs <= 10_000)).toBe(true)
    expect(bounded.retention.providerResponseMaxBytes).toBe(32_000)
    expect(bounded.retention.providerResultMaxBytes).toBe(24_000)
  })

  it('rejects duplicate probe registrations before any operation starts', () => {
    expect(() => new SearchDiagnostics({
      credentials: credentials(),
      probes: [
        probe('main_search', 'search_api'),
        probe('main_search', 'search_api'),
      ],
    })).toThrow(/duplicate diagnostic probe/i)
  })
})

describe('fixed public Provider diagnostic adapters', () => {
  it('uses uncached Search API model-list GET options and one dispatch observer', async () => {
    const listModels = vi.fn(async (_signal: AbortSignal, options: unknown) => {
      expect(options).toEqual({
        cache: false,
        config: expect.objectContaining({ diagnostics: expect.any(Object) }),
        refresh: true,
        onDispatch: expect.any(Function),
      })
      ;(options as { onDispatch: () => void }).onDispatch()
      return { availability: 'available', models: [], cache: 'refresh', attempts: 1, totalDelayMs: 0 }
    })
    const adapter = new SearchApiModelListDiagnosticProbe({ listModels } as never)
    const onDispatch = vi.fn()
    await expect(adapter.probe({
      config: config(),
      signal: new AbortController().signal,
      onDispatch,
    })).resolves.toEqual({ state: 'complete' })
    expect(onDispatch).toHaveBeenCalledTimes(1)
  })

  it('uses only fixed bounded Context7 and source-search queries', async () => {
    const resolve = vi.fn(async (input: unknown) => {
      const value = input as { libraryName: string; query: string; limit: number; onDispatch: () => void }
      value.onDispatch()
      expect(value.query).toBe(DIAGNOSTIC_CONTEXT7_QUERY)
      expect(value.libraryName).toBe(DIAGNOSTIC_CONTEXT7_LIBRARY_NAME)
      expect(value.limit).toBe(DIAGNOSTIC_RESULT_LIMIT)
      return { attempts: 1, libraries: [], responseBytes: 2, totalDelayMs: 0, totalLibraries: 0, truncated: false }
    })
    const search = vi.fn(async (input: unknown) => {
      const value = input as { query: string; limit: number; onDispatch: () => void }
      value.onDispatch()
      expect(value.query).toBe(DIAGNOSTIC_SEARCH_QUERY)
      expect(value.limit).toBe(DIAGNOSTIC_RESULT_LIMIT)
      return {
        state: 'complete' as const,
        attempts: 1,
        totalDelayMs: 0,
        result: {
          sources: [], snippets: [], totalSources: 0, returnedSources: 0,
          totalSnippets: 0, returnedSnippets: 0, responseBytes: 2, truncated: false,
        },
      }
    })
    const onDispatch = vi.fn()
    const input = { config: config(), signal: new AbortController().signal, onDispatch }

    await new Context7ResolveDiagnosticProbe({ resolve } as never).probe(input)
    await new SourceSearchDiagnosticProbe('docs_search', 'exa', { search } as never).probe(input)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledTimes(1)
    expect(onDispatch).toHaveBeenCalledTimes(2)
  })
})
