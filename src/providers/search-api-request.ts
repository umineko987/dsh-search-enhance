import { snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'

import {
  SEARCH_API_PROTOCOLS,
  THINKING_LEVELS,
  type SearchApiConfig,
  type SearchApiProtocol,
  type ThinkingLevel,
} from '../config.js'
import type { ResolvedSearchStrategy } from '../search/profiles.js'
import {
  renderCurrentTimeContext,
  type CurrentTimeContext,
} from '../search/time-context.js'

const TERMINAL_SEARCH_PATH = /\/(?:chat\/completions|responses)\/?$/

function exactEnum<T extends string>(values: readonly T[], value: unknown, label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new TypeError(`${label} must be one of: ${values.join(', ')}`)
  }
  return value as T
}

/** Validate and normalize the configured Grok search model identifier. */
export function normalizeSearchApiModel(model: string): string {
  const trimmed = model.trim()
  if (trimmed.length === 0) throw new RangeError('Search API model must not be empty')
  return trimmed
}

function validatedBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new RangeError('Search API base URL must be an absolute HTTP(S) URL')
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    throw new RangeError('Search API base URL must not contain credentials, query, or fragment')
  }
  return trimmed
}

function baseWithoutTerminalSearchPath(baseUrl: string): string {
  const base = validatedBaseUrl(baseUrl).replace(/\/+$/, '').replace(TERMINAL_SEARCH_PATH, '')
  const url = new URL(base)
  const provider = officialSearchApiProvider(url)
  if (provider === 'xai' && url.pathname === '/') return `${base}/v1`
  if (provider === 'openrouter') {
    if (url.pathname === '/') return `${base}/api/v1`
    if (url.pathname === '/api') return `${base}/v1`
  }
  return base
}

/** Resolve the protocol-specific request endpoint without duplicating a terminal API path. */
export function searchApiEndpoint(baseUrl: string, protocol: SearchApiProtocol): string {
  const selected = exactEnum(SEARCH_API_PROTOCOLS, protocol, 'protocol')
  const terminal = selected === 'responses' ? '/responses' : '/chat/completions'
  return `${baseWithoutTerminalSearchPath(baseUrl)}${terminal}`
}

/** Resolve the Grok-compatible model-list endpoint from the same configured base. */
export function searchApiModelsEndpoint(baseUrl: string): string {
  const base = baseWithoutTerminalSearchPath(baseUrl)
  return base.endsWith('/models') ? base : `${base}/models`
}

/** `off` means omission; every other configured level maps to its identical wire effort. */
export function reasoningEffort(
  thinkingLevel: ThinkingLevel,
): Exclude<ThinkingLevel, 'off'> | undefined {
  const level = exactEnum(THINKING_LEVELS, thinkingLevel, 'thinkingLevel')
  return level === 'off' ? undefined : level
}

export interface BuildSearchApiRequestInput {
  readonly config: SearchApiConfig
  readonly query: string
  readonly strategy: ResolvedSearchStrategy
  readonly timeContext?: CurrentTimeContext
}

export interface PreparedSearchApiRequest {
  readonly endpoint: string
  readonly protocol: SearchApiProtocol
  readonly model: string
  readonly nativeSearch?: 'xai' | 'openrouter'
  /** Detached lossless JSON sent on the wire. */
  readonly body: JsonValue
  readonly serializedBody: string
}

/** Match official HTTPS origins only; compatible proxies keep their existing wire format. */
function officialSearchApiProvider(url: URL): 'xai' | 'openrouter' | undefined {
  if (url.protocol !== 'https:' || url.port !== '') return undefined
  if (['api.x.ai', 'us.api.x.ai'].includes(url.hostname)) return 'xai'
  if (url.hostname === 'openrouter.ai') return 'openrouter'
  return undefined
}

function freezeJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value
  const pending: Array<JsonValue[] | Record<string, JsonValue>> = [
    value as JsonValue[] | Record<string, JsonValue>,
  ]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined || Object.isFrozen(current)) continue
    for (const child of Array.isArray(current) ? current : Object.values(current)) {
      if (child !== null && typeof child === 'object') {
        pending.push(child as JsonValue[] | Record<string, JsonValue>)
      }
    }
    Object.freeze(current)
  }
  return value
}

function snapshotBody(value: unknown): JsonValue {
  const body = snapshotJsonValue(value)
  if (body === undefined) throw new TypeError('Search API request body must be lossless JSON')
  return freezeJson(body as JsonValue)
}

/**
 * Build a complete credential-free Search API request. Authorization is injected
 * only by the dispatch adapter and therefore cannot enter this value.
 */
export function buildSearchApiRequest(input: BuildSearchApiRequestInput): PreparedSearchApiRequest {
  const query = input.query.trim()
  if (query.length === 0) throw new RangeError('Search query must not be empty')
  const configuredProtocol = exactEnum(SEARCH_API_PROTOCOLS, input.config.protocol, 'protocol')
  const level = exactEnum(THINKING_LEVELS, input.config.thinkingLevel, 'thinkingLevel')
  const model = normalizeSearchApiModel(input.config.model)
  const provider = officialSearchApiProvider(new URL(validatedBaseUrl(input.config.baseUrl)))
  const nativeSearch = (provider === 'xai' && model.startsWith('grok-'))
    || (provider === 'openrouter' && model.startsWith('x-ai/grok-')) ? provider : undefined
  // xAI's server-side search tools are available only through Responses.
  const protocol = nativeSearch === 'xai' ? 'responses' : configuredProtocol
  const effort = reasoningEffort(nativeSearch === undefined ? level
    : level === 'minimal' ? 'low' : level === 'max' ? 'xhigh' : level)
  const tools = nativeSearch === 'xai'
    ? [{ type: 'web_search' }, { type: 'x_search' }]
    : nativeSearch === 'openrouter'
      ? [{ type: 'openrouter:web_search', parameters: { engine: 'native' } }]
      : undefined
  const endpoint = searchApiEndpoint(input.config.baseUrl, protocol)
  const user = `${input.timeContext === undefined ? '' : renderCurrentTimeContext(input.timeContext)}${query}`

  const body = protocol === 'responses'
    ? snapshotBody({
        input: user,
        instructions: input.strategy.profilePrompt,
        model,
        ...(effort === undefined ? {} : { reasoning: { effort } }),
        store: false,
        stream: true,
        ...(tools === undefined ? {} : { tools }),
      })
    : snapshotBody({
        messages: [
          { content: input.strategy.profilePrompt, role: 'system' },
          { content: user, role: 'user' },
        ],
        model,
        ...(effort === undefined ? {} : nativeSearch === 'openrouter'
          ? { reasoning: { effort } } : { reasoning_effort: effort }),
        stream: true,
        ...(tools === undefined ? {} : { tools }),
      })

  return Object.freeze({
    body,
    endpoint,
    model,
    protocol,
    ...(nativeSearch === undefined ? {} : { nativeSearch }),
    serializedBody: JSON.stringify(body),
  })
}
