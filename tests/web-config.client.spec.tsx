// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { SlotCore, type PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComponentProps } from 'react'

import * as client from '../src/client/index.js'
import {
  SearchEnhancePluginCard,
  type SearchEnhancePluginCardProps,
} from '../src/client/SearchEnhancePluginCard.js'
import { en, type SearchEnhanceLocaleKey } from '../src/client/locales.js'
import {
  WEB_SUPPLEMENTAL_SEARCH_PROVIDERS,
  type WebConfigSnapshot,
  type WebCredentialSlot,
  type WebCredentialState,
} from '../src/web-config/contracts.js'

// DSH supplies these atoms in the browser; its Node barrel also imports
// unrelated Markdown dependencies that 0.1.5-rc.3 does not ship for Node consumers.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ variant, size, icon, children, ...props }: ComponentProps<typeof import('@deepseek-ai/dsh-client-ui-primitives').Button>) => (
    <button {...props}>{icon}{children}</button>
  ),
  StateDot: () => <span aria-hidden="true" />,
  Menu: ({ open, anchor, items, selectedIds, onSelect }: ComponentProps<typeof import('@deepseek-ai/dsh-client-ui-primitives').Menu>) => (
    <>{anchor}{open ? (
      <div role="menu">
        {items.map(item => 'type' in item ? null : (
          <button key={item.id} role="menuitem" disabled={item.disabled} data-selected={selectedIds?.includes(item.id) ?? false} onClick={() => { onSelect(item.id) }}>
            {item.label}
          </button>
        ))}
      </div>
    ) : null}</>
  ),
}))

function t(
  key: SearchEnhanceLocaleKey,
  params: Record<string, unknown> = {},
): string {
  return Object.entries(params).reduce<string>(
    (value, [name, replacement]) => value.replace(`{${name}}`, String(replacement)),
    String(en[key]),
  )
}

const credentialState = (
  ref: string,
  configured = false,
  source?: string,
): WebCredentialState => ({
  ref,
  configured,
  writable: true,
  available: true,
  ...(source === undefined ? {} : { source }),
})

function snapshot(overrides: Partial<WebConfigSnapshot> = {}): WebConfigSnapshot {
  return {
    namespace: 'search-enhance',
    revision: 0,
    applies: 'restart',
    writable: true,
    value: {
      defaultProfile: 'auto',
      defaultDepth: 'compact',
      toolTimeoutMs: 180_000,
      toolDiscovery: { mode: 'progressive' },
      supplementalSearch: { exa: false, tavily: false, firecrawl: false, maxSourcesPerProvider: 5 },
      searchApi: {
        baseUrl: 'https://grok-gateway.example/v1',
        protocol: 'completions',
        model: 'grok-4.20-beta',
        thinkingLevel: 'off',
        credentialRef: 'TEST_GROK_SEARCH_KEY',
        timeoutMs: 120_000,
      },
      providers: {
        context7: { baseUrl: 'https://context7.com', credentialRef: 'CONTEXT7_API_KEY', timeoutMs: 120_000 },
        exa: { baseUrl: 'https://api.exa.ai', credentialRef: 'EXA_API_KEY', timeoutMs: 120_000 },
        tavily: { baseUrl: 'https://api.tavily.com', credentialRef: 'TAVILY_API_KEY', timeoutMs: 120_000 },
        firecrawl: { baseUrl: 'https://api.firecrawl.dev/v2', credentialRef: 'FIRECRAWL_API_KEY', timeoutMs: 120_000 },
      },
      webExtract: {
        tavily: { enabled: true },
        firecrawl: { enabled: true },
        smartDirect: { enabled: true, proxyUrl: 'http://127.0.0.1:7890' },
        direct: { enabled: true, proxyUrl: 'http://127.0.0.1:7891' },
      },
    },
    base: {
      searchApi: { baseUrl: 'https://api.x.ai/v1', model: 'base-model' },
    },
    user: {
      searchApi: {
        baseUrl: 'https://grok-gateway.example/v1',
        model: 'grok-4.20-beta',
        credentialRef: 'TEST_GROK_SEARCH_KEY',
      },
      webExtract: {
        smartDirect: { proxyUrl: 'http://127.0.0.1:7890' },
        direct: { proxyUrl: 'http://127.0.0.1:7891' },
      },
    },
    options: {
      profiles: ['auto', 'coding_docs', 'code_examples', 'project_research', 'academic', 'fact_check'],
      depths: ['compact', 'normal', 'deep'],
      protocols: ['completions', 'responses'],
      thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      toolDiscoveryModes: ['progressive', 'all'],
      proxyUrlMaxCharacters: 2048,
      supplementalSearchMaxSources: 100,
    },
    credentials: {
      searchApi: credentialState('TEST_GROK_SEARCH_KEY', true, 'file'),
      context7: credentialState('CONTEXT7_API_KEY'),
      exa: credentialState('EXA_API_KEY'),
      tavily: credentialState('TAVILY_API_KEY'),
      firecrawl: credentialState('FIRECRAWL_API_KEY'),
    },
    diagnostics: {
      capabilities: [{
        capability: 'main_search',
        available: true,
        required: true,
        providers: [{ provider: 'search_api', state: 'configured' }],
      }],
      minimumProfile: { profile: 'standard', satisfied: true },
      missingProviders: 4,
      unavailableProviders: 0,
    },
    ...overrides,
  }
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function requestPath(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.pathname
  return new URL(input.url).pathname
}

function requestMethod(init?: RequestInit): string {
  return init?.method ?? 'GET'
}

async function openCard(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: `${en.expand}: ${en.title}` }))
  await screen.findByDisplayValue('https://grok-gateway.example/v1')
}

class TestLocale extends Service {
  readonly namespaces = new Set<string>()

  constructor(ctx: Context) {
    super(ctx, 'locale')
  }

  register(namespace: string): () => void {
    this.namespaces.add(namespace)
    return () => { this.namespaces.delete(namespace) }
  }

  bind() {
    return t
  }
}

class TestSlots extends Service {
  private readonly core = new SlotCore()

  readonly register = this.core.register.bind(this.core)

  constructor(ctx: Context) {
    super(ctx, 'slots')
    this.ctx.effect(() => this.register({
      name: 'root',
      children: { 'settings.plugin.item': { kind: 'keyed', scope: 'root' } },
    }, ({ renderSlot }: PropsRenderSlots<'settings.plugin.item'>) => (
      renderSlot('settings.plugin.item', {}, { entryKey: 'search-enhance' })
    )), 'test settings slot declaration')
  }

  get entries() {
    return this.core.entries('settings.plugin.item')
  }

  inject(_name: string, register: () => unknown): void {
    this.ctx.effect(register as () => () => void, 'test slot injection')
  }
}

const contexts = new Set<Context>()

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await Promise.all([...contexts].map(ctx => ctx.fiber.dispose()))
  contexts.clear()
})

describe('Search Enhance browser contribution', () => {
  it('registers one keyed settings card and cleans it across restart/dispose', async () => {
    const ctx = new Context()
    contexts.add(ctx)
    await ctx.plugin(TestSlots)
    await ctx.plugin(TestLocale)
    const plugin = await ctx.plugin({
      name: client.name,
      inject: client.inject,
      apply: client.apply,
    })
    const slots = ctx.get('slots') as unknown as TestSlots
    const locale = ctx.get('locale') as unknown as TestLocale

    expect(slots.entries).toHaveLength(1)
    expect(slots.entries[0]?.options).toEqual({ key: snapshot().namespace })
    expect(slots.entries[0]?.locale).toBe('settings.search-enhance')
    expect(slots.entries[0]?.component).toBe(SearchEnhancePluginCard)
    expect(locale.namespaces).toEqual(new Set(['settings.search-enhance']))

    await plugin.restart()
    expect(slots.entries).toHaveLength(1)
    expect(slots.entries[0]?.options.key).toBe(snapshot().namespace)
    expect(locale.namespaces).toEqual(new Set(['settings.search-enhance']))

    await plugin.dispose()
    expect(slots.entries).toHaveLength(0)
    expect(locale.namespaces).toHaveLength(0)
  })

  it('loads an existing third-party Grok configuration and saves only the edited path with restart feedback', async () => {
    const initial = snapshot()
    let patchBody: unknown
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      expect(requestPath(input)).toBe('/dsh-search-enhance/config')
      if (requestMethod(init) === 'GET') return response(initial)
      patchBody = JSON.parse(String(init?.body)) as unknown
      const next = snapshot({
        revision: 1,
        value: {
          ...initial.value,
          searchApi: { ...initial.value.searchApi, model: 'grok-custom-next' },
        },
      })
      return response(next)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<SearchEnhancePluginCard t={t as SearchEnhancePluginCardProps['t']} />)
    await openCard()

    expect((screen.getByLabelText(`${en.searchApiCredential} ${en.baseUrl}`) as HTMLInputElement).value).toBe('https://grok-gateway.example/v1')
    expect((screen.getByLabelText(en.model) as HTMLInputElement).value).toBe('grok-4.20-beta')
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(en.independentNote)).toBeTruthy()

    fireEvent.change(screen.getByLabelText(en.model), { target: { value: 'grok-custom-next' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    expect(await screen.findByText(en.savedRestart)).toBeTruthy()
    expect(patchBody).toEqual({
      expectedRevision: 0,
      mutations: [{ op: 'set', path: ['searchApi', 'model'], value: 'grok-custom-next' }],
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((screen.getByLabelText(`${en.searchApiCredential} ${en.baseUrl}`) as HTMLInputElement).value).toBe('https://grok-gateway.example/v1')

    const credentials = within(screen.getByRole('region', { name: en.credentialsHeading }))
    expect(credentials.getByLabelText(`${en.context7} ${en.baseUrl}`)).toBeTruthy()
    expect(credentials.getByLabelText(`${en.firecrawl} ${en.timeoutMs}`)).toBeTruthy()
    expect(credentials.getByLabelText(`${en.searchApiCredential} ${en.baseUrl}`)).toBeTruthy()
    expect(document.querySelector('details')).toBeNull()
  })

  it('saves endpoints and connection settings from their credential cards without sending keys', async () => {
    const initial = snapshot()
    const next = snapshot({ revision: 1, value: {
      ...initial.value,
      searchApi: { ...initial.value.searchApi, baseUrl: 'https://new-grok.example/v1' },
      providers: { ...initial.value.providers, exa: { baseUrl: 'https://new-exa.example', credentialRef: 'NEW_EXA_KEY', timeoutMs: 30_000 } },
    } })
    let patchBody: unknown
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      expect(requestPath(input)).toBe('/dsh-search-enhance/config')
      if (requestMethod(init) === 'GET') return response(initial)
      expect(requestMethod(init)).toBe('PATCH')
      patchBody = JSON.parse(String(init?.body)) as unknown
      return response(next)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SearchEnhancePluginCard t={t as SearchEnhancePluginCardProps['t']} />)
    await openCard()
    const credentials = within(screen.getByRole('region', { name: en.credentialsHeading }))
    fireEvent.change(credentials.getByLabelText(`${en.searchApiCredential} ${en.baseUrl}`), { target: { value: next.value.searchApi.baseUrl } })
    fireEvent.change(credentials.getByLabelText(`${en.exa} ${en.baseUrl}`), { target: { value: next.value.providers.exa.baseUrl } })
    fireEvent.change(credentials.getByLabelText(`${en.exa} ${en.timeoutMs}`), { target: { value: '30000' } })
    fireEvent.change(credentials.getByLabelText(`${en.exa} ${en.credentialRef}`), { target: { value: 'NEW_EXA_KEY' } })
    expect(credentials.getByText(en.saveConfigFirst)).toBeTruthy()
    expect((credentials.getByLabelText(t('keyValue', { name: en.exa })) as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect(await screen.findByText(en.savedRestart)).toBeTruthy()
    expect(patchBody).toEqual({ expectedRevision: 0, mutations: [
      { op: 'set', path: ['searchApi', 'baseUrl'], value: next.value.searchApi.baseUrl },
      { op: 'set', path: ['providers', 'exa', 'baseUrl'], value: next.value.providers.exa.baseUrl },
      { op: 'set', path: ['providers', 'exa', 'credentialRef'], value: 'NEW_EXA_KEY' },
      { op: 'set', path: ['providers', 'exa', 'timeoutMs'], value: 30_000 },
    ] })
    expect((screen.getByLabelText(en.model) as HTMLInputElement).value).toBe(initial.value.searchApi.model)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('edits both extraction proxies and translates a blank optional proxy into an unset mutation', async () => {
    const initial = snapshot()
    let patchBody: unknown
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (requestMethod(init) === 'GET') return response(initial)
      patchBody = JSON.parse(String(init?.body)) as unknown
      return response(snapshot({
        revision: 1,
        value: {
          ...initial.value,
          webExtract: {
            ...initial.value.webExtract,
            smartDirect: { ...initial.value.webExtract.smartDirect, proxyUrl: 'http://127.0.0.1:7892' },
            direct: { ...initial.value.webExtract.direct, proxyUrl: '' },
          },
        },
        user: {
          ...initial.user,
          webExtract: {
            smartDirect: { proxyUrl: 'http://127.0.0.1:7892' },
            direct: {},
          },
        },
      }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<SearchEnhancePluginCard t={t as SearchEnhancePluginCardProps['t']} />)
    await openCard()

    const smartDirect = screen.getByLabelText(en.smartDirectProxy) as HTMLInputElement
    const direct = screen.getByLabelText(en.directProxy) as HTMLInputElement
    expect(smartDirect.value).toBe('http://127.0.0.1:7890')
    expect(direct.value).toBe('http://127.0.0.1:7891')
    expect(smartDirect.maxLength).toBe(2048)

    fireEvent.change(smartDirect, { target: { value: 'http://127.0.0.1:7892' } })
    fireEvent.change(direct, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    expect(await screen.findByText(en.savedRestart)).toBeTruthy()
    expect(patchBody).toEqual({
      expectedRevision: 0,
      mutations: [
        { op: 'set', path: ['webExtract', 'smartDirect', 'proxyUrl'], value: 'http://127.0.0.1:7892' },
        { op: 'unset', path: ['webExtract', 'direct', 'proxyUrl'] },
      ],
    })
  })

  it('edits multiple search Providers and the extraction allowlist, and bounds the per-Provider cap', async () => {
    const initial = snapshot()
    let patchBody: unknown
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (requestMethod(init) === 'GET') return response(initial)
      patchBody = JSON.parse(String(init?.body)) as unknown
      return response(snapshot({
        revision: 1,
        value: {
          ...initial.value,
          supplementalSearch: { ...initial.value.supplementalSearch, exa: true, tavily: true, maxSourcesPerProvider: 10 },
          webExtract: { ...initial.value.webExtract, direct: { ...initial.value.webExtract.direct, enabled: false } },
        },
      }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<SearchEnhancePluginCard t={t as SearchEnhancePluginCardProps['t']} />)
    await openCard()

    const searchSelect = screen.getByRole('button', { name: en.extraSourcesHeading })
    expect(searchSelect.textContent).toContain(en.selectProviders)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(searchSelect)
    for (const provider of WEB_SUPPLEMENTAL_SEARCH_PROVIDERS) {
      expect(screen.getByRole('menuitem', { name: en[provider] }).getAttribute('data-selected')).toBe('false')
    }
    fireEvent.click(screen.getByRole('menuitem', { name: en.exa }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.tavily }))
    expect(searchSelect.textContent).toContain('Exa, Tavily')
    expect(screen.getByRole('menuitem', { name: en.exa }).getAttribute('data-selected')).toBe('true')
    fireEvent.click(screen.getByRole('menuitem', { name: en.exa }))
    expect(searchSelect.textContent).not.toContain('Exa')
    fireEvent.click(screen.getByRole('menuitem', { name: en.exa }))
    fireEvent.click(searchSelect)
    expect(screen.queryByRole('menu')).toBeNull()
    const extractSelect = screen.getByRole('button', { name: en.extractHeading })
    expect(extractSelect.textContent).toContain('Tavily, Firecrawl, smart_direct, direct')
    fireEvent.click(extractSelect)
    fireEvent.click(screen.getByRole('menuitem', { name: en.direct }))
    expect(screen.getByRole('menuitem', { name: en.direct }).getAttribute('data-selected')).toBe('false')
    expect(extractSelect.textContent).toContain('Tavily, Firecrawl, smart_direct')
    expect(extractSelect.textContent).not.toContain(', direct')
    fireEvent.click(extractSelect)
    const research = screen.getByLabelText(en.maxSourcesPerProvider) as HTMLInputElement
    expect(research.value).toBe('5')
    expect(research.min).toBe('1')
    expect(research.max).toBe('100')

    fireEvent.change(research, { target: { value: '101' } })
    expect(screen.getByRole('alert').textContent).toBe(en.invalidNumber)
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(research, { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    expect(await screen.findByText(en.savedRestart)).toBeTruthy()
    expect(patchBody).toEqual({
      expectedRevision: 0,
      mutations: [
        { op: 'set', path: ['supplementalSearch', 'exa'], value: true },
        { op: 'set', path: ['supplementalSearch', 'tavily'], value: true },
        { op: 'set', path: ['supplementalSearch', 'maxSourcesPerProvider'], value: 10 },
        { op: 'set', path: ['webExtract', 'direct', 'enabled'], value: false },
      ],
    })
  })

  it('disables provider dropdowns and endpoint edits for read-only settings', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(snapshot({ writable: false }))))
    render(<SearchEnhancePluginCard t={t as SearchEnhancePluginCardProps['t']} />)
    await openCard()
    for (const name of [en.extraSourcesHeading, en.extractHeading]) {
      const select = screen.getByRole('button', { name }) as HTMLButtonElement
      expect(select.disabled).toBe(true)
      fireEvent.click(select)
    }
    expect(screen.queryByRole('menu')).toBeNull()
    expect((screen.getByLabelText(`${en.exa} ${en.baseUrl}`) as HTMLInputElement).disabled).toBe(true)
  })

  it('keeps the draft and shows a revision conflict instead of retrying over newer settings', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (requestMethod(init) === 'GET') return response(snapshot())
      return response({
        error: {
          code: 'settings-conflict',
          message: 'The Settings document changed after this form was loaded.',
          actualRevision: 7,
        },
      }, 409)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<SearchEnhancePluginCard t={t as SearchEnhancePluginCardProps['t']} />)
    await openCard()
    fireEvent.change(screen.getByLabelText(en.model), { target: { value: 'unsaved-conflicting-model' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    expect(await screen.findByText(en.conflict)).toBeTruthy()
    expect((screen.getByLabelText(en.model) as HTMLInputElement).value).toBe('unsaved-conflicting-model')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('shows credential state, writes a non-empty secret without displaying it, and clears through DELETE', async () => {
    const secret = 'browser-only-secret-value'
    const calls: Array<{ method: string; body: unknown }> = []
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const method = requestMethod(init)
      if (method === 'GET') return response(snapshot())
      const body = JSON.parse(String(init?.body)) as { credential: WebCredentialSlot; value?: string }
      calls.push({ method, body })
      return response({
        credential: body.credential,
        changed: true,
        state: credentialState('TEST_GROK_SEARCH_KEY', method === 'PUT', method === 'PUT' ? 'file' : undefined),
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<SearchEnhancePluginCard t={t as SearchEnhancePluginCardProps['t']} />)
    await openCard()

    const keyInput = screen.getByLabelText(t('keyValue', { name: en.searchApiCredential })) as HTMLInputElement
    const row = keyInput.closest('div[style]')
    expect(row).not.toBeNull()
    const rowQueries = within(row as HTMLElement)
    expect(keyInput.value).toBe('')
    expect(rowQueries.getByText(en.configured)).toBeTruthy()
    expect((rowQueries.getByRole('button', { name: en.updateKey }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(keyInput, { target: { value: secret } })
    fireEvent.click(rowQueries.getByRole('button', { name: en.updateKey }))
    expect(await screen.findByText(t('keySaved', { name: en.searchApiCredential }))).toBeTruthy()
    expect(keyInput.value).toBe('')
    expect(document.body.textContent).not.toContain(secret)
    expect(calls[0]).toEqual({ method: 'PUT', body: { credential: 'searchApi', value: secret } })

    fireEvent.click(rowQueries.getByRole('button', { name: en.clearKey }))
    expect(await screen.findByText(t('keyCleared', { name: en.searchApiCredential }))).toBeTruthy()
    expect(calls[1]).toEqual({ method: 'DELETE', body: { credential: 'searchApi' } })
  })

  it('surfaces load errors, retries without Provider probes, and aborts a pending load on unmount', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ error: { code: 'internal-error', message: 'failed' } }, 500))
      .mockResolvedValueOnce(response(snapshot()))
    vi.stubGlobal('fetch', fetchMock)

    const rendered = render(<SearchEnhancePluginCard t={t as SearchEnhancePluginCardProps['t']} />)
    fireEvent.click(screen.getByRole('button', { name: `${en.expand}: ${en.title}` }))
    expect(await screen.findByText(en.loadFailed)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(await screen.findByDisplayValue('https://grok-gateway.example/v1')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(screen.getByText(en.offlineOnly)).toBeTruthy()
    rendered.unmount()

    let pendingSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      pendingSignal = init?.signal instanceof AbortSignal ? init.signal : undefined
      return new Promise<Response>(() => undefined)
    }))
    const pending = render(<SearchEnhancePluginCard t={t as SearchEnhancePluginCardProps['t']} />)
    fireEvent.click(screen.getByRole('button', { name: `${en.expand}: ${en.title}` }))
    await act(async () => undefined)
    pending.unmount()
    expect(pendingSignal?.aborted).toBe(true)
  })
})
