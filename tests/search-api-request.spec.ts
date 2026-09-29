import { describe, expect, it } from 'vitest'

import {
  Config,
  SEARCH_API_PROTOCOLS,
  THINKING_LEVELS,
  type SearchApiProtocol,
  type ThinkingLevel,
} from '../src/config.js'
import {
  buildSearchApiRequest,
  normalizeSearchApiModel,
  reasoningEffort,
  searchApiEndpoint,
  searchApiModelsEndpoint,
} from '../src/providers/search-api-request.js'
import { resolveSearchStrategy } from '../src/search/index.js'

const resolveConfig = (input: unknown) => Config(input as never)

function prepare(
  protocol: SearchApiProtocol,
  thinkingLevel: ThinkingLevel,
  overrides: Record<string, unknown> = {},
) {
  const config = resolveConfig({
    searchApi: {
      baseUrl: 'https://search.example.test/v1/',
      credentialRef: 'ROTATING_SEARCH_KEY',
      model: 'search-model',
      protocol,
      thinkingLevel,
      ...overrides,
    },
  })
  return buildSearchApiRequest({
    config: config.searchApi,
    query: '  bounded query  ',
    strategy: resolveSearchStrategy(config, { depth: 'normal', profile: 'coding_docs' }),
  })
}

describe('credential-free Search API request construction', () => {
  it.each(SEARCH_API_PROTOCOLS)('selects the required %s endpoint', (protocol) => {
    const request = prepare(protocol, 'off')
    expect(request.endpoint).toBe(protocol === 'responses'
      ? 'https://search.example.test/v1/responses'
      : 'https://search.example.test/v1/chat/completions')
    expect(request).toMatchObject({
      body: request.body,
      endpoint: request.endpoint,
      model: 'search-model',
      protocol,
    })
    expect(request.serializedBody).toBe(JSON.stringify(request.body))
    expect(JSON.stringify(request.body)).toContain('# Search Profile: Coding Docs')
    expect(JSON.stringify(request.body)).toContain('Mode: normal')
    expect(JSON.stringify(request)).not.toContain('ROTATING_SEARCH_KEY')
    expect(request).not.toHaveProperty('credentialRef')
  })

  it.each(THINKING_LEVELS)(
    'maps completions reasoning level %s without aliases',
    (thinkingLevel) => {
      const request = prepare('completions', thinkingLevel)
      const body = request.body as Record<string, unknown>
      expect(body).toMatchObject({
        messages: [
          { content: expect.stringContaining('# Core Instruction'), role: 'system' },
          { content: 'bounded query', role: 'user' },
        ],
        model: 'search-model',
        stream: true,
      })
      if (thinkingLevel === 'off') {
        expect(body).not.toHaveProperty('reasoning_effort')
      } else {
        expect(body.reasoning_effort).toBe(thinkingLevel)
      }
    },
  )

  it.each(THINKING_LEVELS)(
    'maps Responses reasoning level %s without aliases',
    (thinkingLevel) => {
      const request = prepare('responses', thinkingLevel)
      const body = request.body as Record<string, unknown>
      expect(body).toMatchObject({
        input: 'bounded query',
        instructions: expect.stringContaining('# Search Profile: Coding Docs'),
        model: 'search-model',
        store: false,
        stream: true,
      })
      expect(body).not.toHaveProperty('messages')
      if (thinkingLevel === 'off') expect(body).not.toHaveProperty('reasoning')
      else expect(body.reasoning).toEqual({ effort: thinkingLevel })
    },
  )

  it('includes the exact injected time context in the wire body', () => {
    const config = resolveConfig({
      searchApi: {
        model: 'search-model',
        protocol: 'responses',
      },
    })
    const request = buildSearchApiRequest({
      config: config.searchApi,
      query: 'latest release',
      strategy: resolveSearchStrategy(config),
      timeContext: {
        date: '2026-01-02',
        time: '03:04:05',
        timeZone: 'UTC',
      },
    })

    expect((request.body as Record<string, unknown>).input).toBe(
      '[Current Time Context]\n'
      + '- Date: 2026-01-02\n'
      + '- Time: 03:04:05\n'
      + '- Timezone: UTC\n\n'
      + 'latest release',
    )
    expect(request.serializedBody).toBe(JSON.stringify(request.body))
  })

  it.each(SEARCH_API_PROTOCOLS)('enables xAI native tools via Responses even when %s is selected', (protocol) => {
    const request = prepare(protocol, 'high', {
      baseUrl: 'https://api.x.ai/chat/completions/',
      model: 'grok-4.6',
    })
    expect(request).toMatchObject({
      endpoint: 'https://api.x.ai/v1/responses',
      protocol: 'responses',
      nativeSearch: 'xai',
      body: {
        model: 'grok-4.6',
        reasoning: { effort: 'high' },
        tools: [{ type: 'web_search' }, { type: 'x_search' }],
        store: false,
        stream: true,
      },
    })
    expect(request.body).not.toHaveProperty('messages')
    expect(Object.isFrozen((request.body as { tools: unknown[] }).tools)).toBe(true)
  })

  it.each(SEARCH_API_PROTOCOLS)('enables the strict OpenRouter native web plugin while retaining %s', (protocol) => {
    const request = prepare(protocol, 'max', {
      baseUrl: 'https://openrouter.ai',
      model: 'x-ai/grok-4.20-multi-agent',
    })
    expect(request.protocol).toBe(protocol)
    expect(request.endpoint).toBe(`https://openrouter.ai/api/v1/${protocol === 'responses' ? 'responses' : 'chat/completions'}`)
    expect(request.body).toMatchObject({
      model: 'x-ai/grok-4.20-multi-agent',
      reasoning: { effort: 'xhigh' },
      plugins: [{ id: 'web', engine: 'native' }],
    })
    expect(request.body).not.toHaveProperty('reasoning_effort')
    expect(request.body).not.toHaveProperty('tools')
  })

  it('supports the official regional endpoint and maps minimal reasoning without changing off', () => {
    const overrides = { baseUrl: 'https://us.api.x.ai/v1', model: 'grok-4.6' }
    expect(prepare('completions', 'minimal', overrides).body).toHaveProperty('reasoning.effort', 'low')
    expect(prepare('responses', 'off', overrides).body).not.toHaveProperty('reasoning')
  })

  it.each([
    ['https://openrouter.ai.evil.test/api/v1', 'x-ai/grok-4.6'],
    ['https://api.x.ai.evil.test/v1', 'grok-4.6'],
    ['https://proxy.test/api.x.ai/v1', 'grok-4.6'],
    ['https://openrouter.ai:8443/api/v1', 'x-ai/grok-4.6'],
    ['http://api.x.ai/v1', 'grok-4.6'],
    ['https://openrouter.ai/api/v1', 'openai/gpt-5.2'],
    ['https://api.x.ai/v1', 'another-model'],
  ])('leaves other origins or models unchanged: %s %s', (baseUrl, model) => {
    const request = prepare('completions', 'max', { baseUrl, model })
    expect(request.protocol).toBe('completions')
    expect(request).not.toHaveProperty('nativeSearch')
    expect(request.body).not.toHaveProperty('tools')
    expect(request.body).toHaveProperty('reasoning_effort', 'max')
  })

  it.each([
    ['https://api.x.ai', 'https://api.x.ai/v1'],
    ['https://us.api.x.ai/', 'https://us.api.x.ai/v1'],
    ['https://openrouter.ai', 'https://openrouter.ai/api/v1'],
    ['https://openrouter.ai/api/', 'https://openrouter.ai/api/v1'],
    ['https://api.x.ai/v1/responses/', 'https://api.x.ai/v1'],
    ['https://openrouter.ai/api/v1/chat/completions/', 'https://openrouter.ai/api/v1'],
  ])('completes official API paths once for search and model discovery: %s', (baseUrl, expectedBase) => {
    for (const protocol of SEARCH_API_PROTOCOLS) {
      const endpoint = searchApiEndpoint(baseUrl, protocol)
      expect(endpoint).toBe(`${expectedBase}/${protocol === 'responses' ? 'responses' : 'chat/completions'}`)
      expect(searchApiEndpoint(endpoint, protocol)).toBe(endpoint)
      expect(searchApiModelsEndpoint(endpoint)).toBe(`${expectedBase}/models`)
    }
    expect(searchApiModelsEndpoint(baseUrl)).toBe(`${expectedBase}/models`)
  })

  it.each([
    'https://proxy.test',
    'https://api.x.ai.evil.test',
    'https://openrouter.ai:8443',
    'http://api.x.ai',
    'https://api.x.ai/custom/v2',
    'https://openrouter.ai/api/v2',
  ])('preserves other origins and explicit versioned/custom paths: %s', baseUrl => {
    expect(searchApiEndpoint(baseUrl, 'responses')).toBe(`${baseUrl}/responses`)
    expect(searchApiModelsEndpoint(baseUrl)).toBe(`${baseUrl}/models`)
  })

  it('normalizes terminal paths and preserves the configured Grok model id', () => {
    expect(searchApiEndpoint('https://host.test/v1/responses', 'completions'))
      .toBe('https://host.test/v1/chat/completions')
    expect(searchApiEndpoint('https://host.test/v1/chat/completions', 'responses'))
      .toBe('https://host.test/v1/responses')
    expect(searchApiModelsEndpoint('https://host.test/v1/chat/completions'))
      .toBe('https://host.test/v1/models')
    expect(normalizeSearchApiModel('  grok-search-model  ')).toBe('grok-search-model')
  })

  it('rejects every unknown protocol/thinking enum and empty model/query', () => {
    expect(() => searchApiEndpoint('https://host.test/v1', 'chat' as SearchApiProtocol))
      .toThrow(TypeError)
    expect(() => searchApiEndpoint('https://secret@host.test/v1', 'completions'))
      .toThrow('must not contain credentials')
    expect(() => searchApiModelsEndpoint('https://host.test/v1?key=secret'))
      .toThrow('must not contain credentials, query, or fragment')
    expect(() => reasoningEffort('none' as ThinkingLevel)).toThrow(TypeError)
    expect(() => normalizeSearchApiModel('  ')).toThrow(RangeError)

    const config = resolveConfig({ searchApi: { model: 'model' } })
    expect(() => buildSearchApiRequest({
      config: config.searchApi,
      query: '  ',
      strategy: resolveSearchStrategy(config),
    })).toThrow(RangeError)
  })
})
