import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'

import type { CanonicalSource } from '../contracts/index.js'
import { ProviderError, truncateCharacters } from '../provider-runtime/index.js'
import { boundSourceProviderResult } from './bounded-result.js'
import {
  canonicalHttpUrl,
  credentialIsConfigured,
  firstString,
  isRecord,
  nonEmptyQuery,
  parseProviderJson,
  positiveLimit,
  providerEndpoint,
  resolveOptionalCredential,
  type ProviderCredentials,
} from './helpers.js'
import { ProviderHttpClient, type ProviderHttpDependencies } from './http.js'
import type {
  BoundedSourceProvider,
  SourceProviderSearchInput,
  SourceProviderSearchOutcome,
} from './types.js'

const PROVIDER = 'parallel'
const CAPABILITY = 'web_search'
const MAX_RESULTS = 20

export interface ParallelSearchProviderDependencies extends ProviderHttpDependencies {
  readonly credentials: Pick<CredentialProvider, 'describe' | 'resolve'>
}

/** Normalize discovery excerpts; never treat them as fetched page-body evidence. */
export function parseParallelSearchSources(
  body: string,
  maximumUrlCharacters: number,
): readonly CanonicalSource[] {
  const data = parseProviderJson(body, PROVIDER, CAPABILITY)
  if (!isRecord(data) || !Array.isArray(data.results)) {
    throw new ProviderError({ capability: CAPABILITY, kind: 'invalid_response', provider: PROVIDER })
  }
  const sources: CanonicalSource[] = []
  for (const item of data.results) {
    if (!isRecord(item)) continue
    const url = canonicalHttpUrl(firstString(item, ['url']), maximumUrlCharacters)
    if (url === undefined) continue
    const title = firstString(item, ['title'])
    const publishedAt = firstString(item, ['publish_date'])
    const snippet = Array.isArray(item.excerpts)
      ? item.excerpts.filter((excerpt): excerpt is string => typeof excerpt === 'string')
        .map(excerpt => excerpt.trim()).filter(Boolean).join('\n\n')
      : ''
    sources.push(Object.freeze({
      provider: PROVIDER,
      ...(title === undefined ? {} : { title }),
      ...(publishedAt === undefined ? {} : { publishedAt }),
      ...(snippet.length === 0 ? {} : { snippet }),
      url,
    }))
  }
  return Object.freeze(sources)
}

/** Optional supplemental Search adapter; it does not change documentation routing. */
export class ParallelSearchProvider implements BoundedSourceProvider {
  readonly capability = CAPABILITY
  readonly provider = PROVIDER
  private readonly credentials: ProviderCredentials
  private readonly http: ProviderHttpClient

  constructor(dependencies: ParallelSearchProviderDependencies) {
    this.credentials = dependencies.credentials
    this.http = new ProviderHttpClient(dependencies)
  }

  async configured(config: SourceProviderSearchInput['config']): Promise<boolean> {
    return credentialIsConfigured(this.credentials, config.providers.parallel.credentialRef, PROVIDER, CAPABILITY)
  }

  async search(input: SourceProviderSearchInput): Promise<SourceProviderSearchOutcome> {
    const query = nonEmptyQuery(input.query, PROVIDER, CAPABILITY)
    const limit = Math.min(positiveLimit(input.limit, PROVIDER, CAPABILITY), MAX_RESULTS)
    const providerConfig = input.config.providers.parallel
    const credential = await resolveOptionalCredential(
      this.credentials, providerConfig.credentialRef, input.signal, PROVIDER, CAPABILITY,
    )
    if (credential === undefined) return Object.freeze({ state: 'not_configured' })

    const response = await this.http.requestText({
      capability: CAPABILITY,
      endpoint: providerEndpoint(providerConfig.baseUrl, '/v1/search'),
      init: {
        body: JSON.stringify({
          advanced_settings: { max_results: limit },
          max_chars_total: Math.max(1, Math.floor(input.config.retention.providerResultMaxBytes / 4)),
          mode: providerConfig.mode,
          objective: query,
          // Preserve the full objective, without adding an LLM query-rewriting step.
          search_queries: [truncateCharacters(query, 200).text],
        }),
        headers: { 'Content-Type': 'application/json', 'x-api-key': credential.value },
        method: 'POST',
      },
      maximumResponseBytes: input.config.retention.providerResponseMaxBytes,
      ...(input.onDispatch === undefined ? {} : { onDispatch: input.onDispatch }),
      provider: PROVIDER,
      retry: input.config.retry,
      signal: input.signal,
      timeoutMs: providerConfig.timeoutMs,
    })
    return Object.freeze({
      attempts: response.attempts,
      result: boundSourceProviderResult({
        capability: CAPABILITY,
        config: input.config,
        provider: PROVIDER,
        requestedSources: limit,
        responseBytes: response.responseBytes,
        sources: parseParallelSearchSources(response.body, input.config.webExtract.maxUrlCharacters),
      }),
      state: 'complete',
      totalDelayMs: response.totalDelayMs,
    })
  }
}
