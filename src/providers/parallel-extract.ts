import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'

import type { Config } from '../config.js'
import { ProviderError, throwIfAborted } from '../provider-runtime/index.js'
import {
  firstString,
  isRecord,
  parseProviderJson,
  providerEndpoint,
  resolveOptionalCredential,
} from './helpers.js'
import { ProviderHttpClient, type ProviderHttpDependencies } from './http.js'
import { boundedExtractedContent, isLikelyAntiBotChallenge } from './web-extract-common.js'
import type {
  WebExtractAdapter,
  WebExtractAdapterInput,
  WebExtractAdapterOutcome,
  WebExtractAdapterResult,
  WebExtractFormat,
} from '../web-extract/types.js'

const PROVIDER = 'parallel_extract'
const CAPABILITY = 'web_extract'

export interface ParallelExtractProviderDependencies extends ProviderHttpDependencies {
  readonly credentials: Pick<CredentialProvider, 'resolve'>
}

/** Full Markdown only: excerpts and error bodies must not masquerade as a page body. */
export function parseParallelExtractResponse(
  body: string,
  maximumContentCharacters: number,
): WebExtractAdapterResult | undefined {
  const data = parseProviderJson(body, PROVIDER, CAPABILITY)
  if (!isRecord(data) || !Array.isArray(data.results)) {
    throw new ProviderError({ capability: CAPABILITY, kind: 'invalid_response', provider: PROVIDER })
  }
  const item = data.results[0]
  if (!isRecord(item)) return undefined
  if (typeof item.full_content === 'string' && isLikelyAntiBotChallenge(item.full_content)) {
    throw new ProviderError({ capability: CAPABILITY, kind: 'unavailable', provider: PROVIDER })
  }
  const content = boundedExtractedContent(item.full_content, maximumContentCharacters)
  if (content === undefined) return undefined
  const title = firstString(item, ['title'])
  const publishedAt = firstString(item, ['publish_date'])
  return {
    ...content,
    // A result URL is not documented as the final HTTP URL. Keep only explicit page metadata.
    ...(title === undefined ? {} : { title }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
  }
}

/** One explicitly selected remote route; no local fetch or stale-cache fallback. */
export class ParallelExtractProvider implements WebExtractAdapter {
  readonly route = PROVIDER
  private readonly credentials: Pick<CredentialProvider, 'resolve'>
  private readonly http: ProviderHttpClient

  constructor(dependencies: ParallelExtractProviderDependencies) {
    this.credentials = dependencies.credentials
    this.http = new ProviderHttpClient(dependencies)
  }

  supports(format: WebExtractFormat): boolean {
    return format === 'markdown'
  }

  enabled(config: Config): boolean {
    return config.webExtract.parallel.enabled
  }

  async extract(input: WebExtractAdapterInput): Promise<WebExtractAdapterOutcome> {
    throwIfAborted(input.signal)
    if (!this.supports(input.format)) return { state: 'unavailable' }
    const providerConfig = input.config.providers.parallel
    const routeConfig = input.config.webExtract.parallel
    const credential = await resolveOptionalCredential(
      this.credentials, providerConfig.credentialRef, input.signal, PROVIDER, CAPABILITY,
    )
    if (credential === undefined) return { state: 'not_configured' }
    const maximumContentCharacters = Math.min(routeConfig.maxContentCharacters, input.config.webExtract.maxContentCharacters)
    const response = await this.http.requestText({
      capability: CAPABILITY,
      endpoint: providerEndpoint(providerConfig.baseUrl, '/v1/extract'),
      init: {
        body: JSON.stringify({
          advanced_settings: {
            fetch_policy: { disable_cache_fallback: true, max_age_seconds: 600 },
            // One extra character lets the local bound detect upstream content truncation.
            full_content: { max_chars_per_result: maximumContentCharacters + 1 },
          },
          urls: [input.url],
        }),
        headers: { 'Content-Type': 'application/json', 'x-api-key': credential.value },
        method: 'POST',
      },
      maximumResponseBytes: routeConfig.maxResponseBytes,
      ...(input.onDispatch === undefined ? {} : { onDispatch: input.onDispatch }),
      provider: PROVIDER,
      retry: input.config.retry,
      signal: input.signal,
      timeoutMs: routeConfig.timeoutMs,
    })
    throwIfAborted(input.signal)
    const result = parseParallelExtractResponse(response.body, maximumContentCharacters)
    return result === undefined ? { state: 'unavailable' } : { result, state: 'complete' }
  }
}
