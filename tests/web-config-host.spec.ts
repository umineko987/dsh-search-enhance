import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  CredentialProvider,
  type CredentialInfo,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { Service } from '@deepseek-ai/cordis'
import type { ConfigEditor } from '@deepseek-ai/dsh-config-editor'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import {
  Config,
  SUPPLEMENTAL_SEARCH_MAX_SOURCES,
  SEARCH_PROFILES,
  WEB_EXTRACT_PROXY_URL_MAX_CHARACTERS,
  type Config as SearchEnhanceConfig,
} from '../src/config.js'
import {
  installWebConfigBridge,
  isTrustedWebConfigRequest,
  WEB_CONFIG_REQUEST_MAX_BYTES,
} from '../src/web-config/host.js'
import {
  WEB_CONFIG_PATH,
  WEB_CREDENTIALS_PATH,
  WEB_EDITABLE_PATHS,
  WEB_MODEL_MAX_CHARACTERS,
  type WebConfigSnapshot,
} from '../src/web-config/contracts.js'

interface MemoryEditorConfig {
  document: Record<string, unknown>
  base: SearchEnhanceConfig
}

function merge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(base)
  for (const [key, value] of Object.entries(override)) {
    result[key] = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? merge((result[key] ?? {}) as Record<string, unknown>, value as Record<string, unknown>)
      : value
  }
  return result
}

let editorId = 0
class MemoryConfigEditor extends Service {
  private stored: Record<string, unknown>
  private base: SearchEnhanceConfig
  private entry: Entry
  readonly documentPath = `/tmp/search-enhance-test-${++editorId}/patch.yml`
  failPersistMessage: string | undefined

  constructor(ctx: Context, { document, base }: MemoryEditorConfig) {
    super(ctx, 'configEditor')
    this.stored = structuredClone(document)
    this.base = base
    const config = merge(base as unknown as Record<string, unknown>, document['search-enhance'] as Record<string, unknown>)
    this.entry = {
      options: { id: 'search-enhance', name: 'dsh-search-enhance', config },
      fiber: { config: Config(structuredClone(config) as never) },
    } as unknown as Entry
  }

  configuration(): ReturnType<ConfigEditor['configuration']> {
    return [{
      entry: this.entry,
      inherited: structuredClone(this.base) as unknown as Record<string, unknown>,
      override: structuredClone(this.stored['search-enhance']) as Record<string, unknown>,
    }]
  }

  async edit(entry: Entry, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
    if (entry !== this.entry) throw new Error('Entry changed')
    const next = change(structuredClone(entry.options.config ?? {}), structuredClone(this.base) as unknown as Record<string, unknown>)
    const resolved = Config(structuredClone(next) as never)
    if (this.failPersistMessage !== undefined) throw new Error(this.failPersistMessage)
    this.stored['search-enhance'] = structuredClone(next)
    this.entry.options.config = next
    ;(this.entry.fiber as { config: SearchEnhanceConfig }).config = resolved
  }

  snapshotDocument(): Record<string, unknown> {
    return structuredClone(this.stored)
  }
}

interface MemoryCredentialsConfig {
  values?: Record<string, string>
}

class MemoryCredentials extends CredentialProvider {
  readonly values: Map<string, string>
  readonly readOnly = new Set<string>()
  readonly unavailable = new Set<string>()
  readonly setCalls: Array<{ ref: string; value: string }> = []
  readonly unsetCalls: string[] = []

  constructor(ctx: Context, config: MemoryCredentialsConfig = {}) {
    super(ctx)
    this.values = new Map(Object.entries(config.values ?? {}))
  }

  // This fixture exercises credential references, not the record API added in dsh 0.1.1.
  readRecord(): never { throw new Error('Record credentials are outside this fixture') }
  describeRecord(): never { throw new Error('Record credentials are outside this fixture') }
  listRecords(): never { throw new Error('Record credentials are outside this fixture') }
  modifyRecord(): never { throw new Error('Record credentials are outside this fixture') }
  deleteRecord(): never { throw new Error('Record credentials are outside this fixture') }

  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(String(ref))
    return value === undefined || value === '' ? undefined : { value, source: 'file' }
  }

  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    const key = String(ref)
    if (this.unavailable.has(key)) throw new Error('credential backend unavailable')
    const configured = (this.values.get(key)?.length ?? 0) > 0
    return {
      configured,
      writable: !this.readOnly.has(key),
      ...(configured ? { source: this.readOnly.has(key) ? 'env' : 'file' } : {}),
    }
  }

  async set(ref: CredentialRef, value: string): Promise<void> {
    if (value === '') throw new Error('empty credentials are rejected')
    const key = String(ref)
    if (this.readOnly.has(key)) throw new Error('read-only credential source')
    this.setCalls.push({ ref: key, value })
    this.values.set(key, value)
    this.notifyUpdated(ref)
  }

  async unset(ref: CredentialRef): Promise<void> {
    const key = String(ref)
    if (this.readOnly.has(key)) throw new Error('read-only credential source')
    this.unsetCalls.push(key)
    this.values.delete(key)
    this.notifyUpdated(ref)
  }
}

interface Harness {
  ctx: Context
  origin: string
  owner: Awaited<ReturnType<Context['plugin']>>
  editor: MemoryConfigEditor
  credentials: MemoryCredentials
  base: SearchEnhanceConfig
}

const contexts = new Set<Context>()

const initialDocument = (): Record<string, unknown> => ({
  'search-enhance': {
    searchApi: {
      baseUrl: 'https://grok-gateway.example/v1',
      protocol: 'completions',
      model: 'grok-4.20-beta',
      credentialRef: 'TEST_GROK_SEARCH_KEY',
    },
    providers: {
      context7: {
        baseUrl: 'https://context7.example/v1',
      },
      exa: {
        timeoutMs: 90_000,
      },
    },
    webExtract: {
      smartDirect: { proxyUrl: 'http://127.0.0.1:7890' },
      direct: { proxyUrl: 'http://127.0.0.1:7890' },
    },
    futureField: {
      keep: true,
    },
  },
  'llm-pi-ai': {
    provider: 'conversation-only',
    model: 'must-not-change',
  },
})

function ownerPlugin() {
  return {
    name: 'search-enhance-web-config-fixture',
    inject: ['configEditor', 'credentials'],
    apply(ctx: Context) { installWebConfigBridge(ctx) },
  }
}

async function createHarness(document = initialDocument()): Promise<Harness> {
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(MemoryCredentials, { values: { TEST_GROK_SEARCH_KEY: 'fixture-secret-value' } })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const base = Config({
    searchApi: {
      baseUrl: 'https://api.x.ai/v1',
      protocol: 'completions',
      model: 'base-model',
    },
  } as never)
  await ctx.plugin(MemoryConfigEditor, { document, base })
  const owner = await ctx.plugin(ownerPlugin())
  const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  await vi.waitFor(async () => {
    const response = await fetch(`${origin}${WEB_CONFIG_PATH}`)
    expect(response.status).toBe(200)
  })
  return {
    ctx,
    origin,
    owner,
    editor: ctx.configEditor as unknown as MemoryConfigEditor,
    credentials: ctx.credentials as unknown as MemoryCredentials,
    base,
  }
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text()) as Record<string, unknown>
}

async function mutate(
  harness: Harness,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${harness.origin}${WEB_CONFIG_PATH}`, {
    method: 'PATCH',
    headers: {
      origin: harness.origin,
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

afterEach(async () => {
  await Promise.all([...contexts].map(ctx => ctx.fiber.dispose()))
  contexts.clear()
})

describe('Search Enhance Web configuration Host bridge', () => {
  it('returns bounded resolved/base/user layers, offline status, and no credential values', async () => {
    const harness = await createHarness()
    const response = await fetch(`${harness.origin}${WEB_CONFIG_PATH}`)
    const text = await response.text()
    const snapshot = JSON.parse(text) as WebConfigSnapshot

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(snapshot.revision).toBe(0)
    expect(snapshot.applies).toBe('live')
    expect(snapshot.value.searchApi).toMatchObject({
      baseUrl: 'https://grok-gateway.example/v1',
      protocol: 'completions',
      model: 'grok-4.20-beta',
      credentialRef: 'TEST_GROK_SEARCH_KEY',
    })
    expect(snapshot.base?.searchApi).toMatchObject({ baseUrl: 'https://api.x.ai/v1', model: 'base-model' })
    expect(snapshot.user?.searchApi).toMatchObject({
      baseUrl: 'https://grok-gateway.example/v1',
      model: 'grok-4.20-beta',
    })
    expect(snapshot.value.webExtract).toMatchObject({
      tavily: { enabled: true }, firecrawl: { enabled: true },
      smartDirect: { enabled: true, proxyUrl: 'http://127.0.0.1:7890' },
      direct: { enabled: true, proxyUrl: 'http://127.0.0.1:7890' },
    })
    expect(snapshot.value.webExtract).toMatchObject(snapshot.user?.webExtract ?? {})
    expect(snapshot.options.proxyUrlMaxCharacters).toBe(WEB_EXTRACT_PROXY_URL_MAX_CHARACTERS)
    expect(snapshot.credentials.searchApi).toEqual({
      ref: 'TEST_GROK_SEARCH_KEY',
      configured: true,
      writable: true,
      available: true,
      source: 'file',
    })
    expect(snapshot.diagnostics.capabilities.length).toBeGreaterThan(0)
    expect(text).not.toContain('fixture-secret-value')
    expect(text).not.toContain('must-not-change')
  })

  it('edits supplemental selections and extract allowlist independently with bounded limits', async () => {
    const harness = await createHarness()
    const snapshot = await (await fetch(`${harness.origin}${WEB_CONFIG_PATH}`)).json() as WebConfigSnapshot
    expect(snapshot.value.supplementalSearch).toEqual({ exa: false, tavily: false, firecrawl: false, parallel: false, maxSourcesPerProvider: 5 })
    expect(snapshot.options.supplementalSearchMaxSources).toBe(SUPPLEMENTAL_SEARCH_MAX_SOURCES)

    const updated = await mutate(harness, {
      expectedRevision: 0,
      mutations: [
        { op: 'set', path: ['supplementalSearch', 'exa'], value: true },
        { op: 'set', path: ['supplementalSearch', 'tavily'], value: true },
        { op: 'set', path: ['supplementalSearch', 'parallel'], value: true },
        { op: 'set', path: ['providers', 'parallel', 'mode'], value: 'advanced' },
        { op: 'set', path: ['webExtract', 'parallel', 'enabled'], value: true },
        { op: 'set', path: ['webExtract', 'tavily', 'enabled'], value: false },
      ],
    })
    const applied = await updated.json() as WebConfigSnapshot
    expect(updated.status).toBe(200)
    expect(applied.value.supplementalSearch).toMatchObject({ exa: true, tavily: true, firecrawl: false, parallel: true })
    expect(applied.value.providers.parallel.mode).toBe('advanced')
    expect(applied.value.webExtract.parallel.enabled).toBe(true)
    expect(applied.value.webExtract.tavily.enabled).toBe(false)
    expect(applied.user?.supplementalSearch).toEqual({ exa: true, tavily: true, parallel: true })

    for (const mutation of [
      { op: 'set', path: ['supplementalSearch', 'maxSourcesPerProvider'], value: SUPPLEMENTAL_SEARCH_MAX_SOURCES + 1 },
      { op: 'set', path: ['supplementalSearch', 'exa'], value: 'yes' },
      { op: 'set', path: ['providers', 'parallel', 'mode'], value: 'unsupported' },
    ]) {
      const rejected = await mutate(harness, { expectedRevision: 1, mutations: [mutation] })
      expect(rejected.status).toBe(422)
    }
  })

  it('mutates one path with revision fencing and preserves third-party, provider, future, and unrelated settings', async () => {
    const harness = await createHarness()
    const response = await mutate(harness, {
      expectedRevision: 0,
      mutations: [{ op: 'set', path: ['searchApi', 'model'], value: 'grok-third-party-next' }],
    })
    const snapshot = await response.json() as WebConfigSnapshot
    const stored = harness.editor.snapshotDocument()
    const search = stored['search-enhance'] as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(snapshot.revision).toBe(1)
    expect(snapshot.value.searchApi.baseUrl).toBe('https://grok-gateway.example/v1')
    expect(snapshot.value.searchApi.model).toBe('grok-third-party-next')
    expect(snapshot.user?.searchApi?.thinkingLevel).toBeUndefined()
    expect(snapshot.user?.providers?.exa?.timeoutMs).toBe(90_000)
    expect(search['futureField']).toEqual({ keep: true })
    expect(search['providers']).toMatchObject({
      context7: { baseUrl: 'https://context7.example/v1' },
      exa: { timeoutMs: 90_000 },
    })
    expect(search['webExtract']).toMatchObject({
      smartDirect: { proxyUrl: 'http://127.0.0.1:7890' },
      direct: { proxyUrl: 'http://127.0.0.1:7890' },
    })
    expect(stored['llm-pi-ai']).toEqual({
      provider: 'conversation-only',
      model: 'must-not-change',
    })

    const noOp = await mutate(harness, { expectedRevision: 1, mutations: [] })
    expect((await noOp.json() as WebConfigSnapshot).revision).toBe(1)
    expect(harness.editor.snapshotDocument()).toEqual(stored)
  })

  it('sets and clears the two optional extraction proxies without rewriting other settings', async () => {
    const harness = await createHarness()
    const updated = await mutate(harness, {
      expectedRevision: 0,
      mutations: [
        { op: 'set', path: ['webExtract', 'smartDirect', 'proxyUrl'], value: 'http://127.0.0.1:7892' },
        { op: 'unset', path: ['webExtract', 'direct', 'proxyUrl'] },
      ],
    })
    const snapshot = await updated.json() as WebConfigSnapshot
    const stored = harness.editor.snapshotDocument()
    const search = stored['search-enhance'] as Record<string, unknown>
    const webExtract = search['webExtract'] as Record<string, Record<string, unknown>>

    expect(updated.status).toBe(200)
    expect(snapshot.revision).toBe(1)
    expect(snapshot.value.webExtract).toMatchObject({
      smartDirect: { proxyUrl: 'http://127.0.0.1:7892' },
      direct: { proxyUrl: '' },
    })
    expect(snapshot.user?.webExtract?.smartDirect?.proxyUrl).toBe('http://127.0.0.1:7892')
    expect(snapshot.user?.webExtract?.direct?.proxyUrl).toBeUndefined()
    expect(webExtract['smartDirect']?.['proxyUrl']).toBe('http://127.0.0.1:7892')
    expect(webExtract['direct']?.['proxyUrl']).toBeUndefined()
    expect(stored['llm-pi-ai']).toEqual({
      provider: 'conversation-only',
      model: 'must-not-change',
    })

    const beforeInvalid = harness.editor.snapshotDocument()
    const invalid = await mutate(harness, {
      expectedRevision: 1,
      mutations: [{
        op: 'set',
        path: ['webExtract', 'direct', 'proxyUrl'],
        value: 'https://127.0.0.1:7891',
      }],
    })
    expect(invalid.status).toBe(422)
    expect((await json(invalid)).error).toMatchObject({ code: 'settings-rejected' })
    expect(harness.editor.snapshotDocument()).toEqual(beforeInvalid)
  })

  it('maps revision conflicts, schema rejection, invalid paths, and infrastructure failures safely', async () => {
    const harness = await createHarness()
    const row = harness.editor.configuration()[0]!
    await harness.editor.edit(row.entry, current => ({ ...current, defaultDepth: 'normal' }))

    const conflict = await mutate(harness, {
      expectedRevision: 0,
      mutations: [{ op: 'set', path: ['searchApi', 'model'], value: 'stale-write' }],
    })
    expect(conflict.status).toBe(409)
    expect(await json(conflict)).toEqual({
      error: {
        code: 'settings-conflict',
        message: 'The configuration changed after this form was loaded.',
        actualRevision: 1,
      },
    })

    const rejected = await mutate(harness, {
      expectedRevision: 1,
      mutations: [{ op: 'set', path: ['searchApi', 'protocol'], value: 'not-a-protocol' }],
    })
    expect(rejected.status).toBe(422)
    expect((await json(rejected)).error).toMatchObject({ code: 'settings-rejected' })

    const invalidPath = await mutate(harness, {
      expectedRevision: 1,
      mutations: [{ op: 'set', path: ['llm-pi-ai', 'model'], value: 'forbidden' }],
    })
    expect(invalidPath.status).toBe(400)
    expect((await json(invalidPath)).error).toMatchObject({ code: 'invalid-mutation-path' })

    harness.editor.failPersistMessage = 'do-not-leak-this-storage-detail'
    const failed = await mutate(harness, {
      expectedRevision: 1,
      mutations: [{ op: 'set', path: ['searchApi', 'model'], value: 'will-fail' }],
    })
    const failedText = await failed.text()
    expect(failed.status).toBe(500)
    expect(failedText).toContain('settings-write-failed')
    expect(failedText).not.toContain('do-not-leak-this-storage-detail')
  })

  it('enforces method, content type, JSON, body-size, same-origin, loopback, and forwarding limits', async () => {
    const harness = await createHarness()

    const method = await fetch(`${harness.origin}${WEB_CONFIG_PATH}`, { method: 'POST' })
    expect(method.status).toBe(405)
    expect(method.headers.get('allow')).toBe('GET, PATCH')

    const media = await mutate(harness, '{}', { 'content-type': 'text/plain' })
    expect(media.status).toBe(415)

    const malformed = await mutate(harness, '{')
    expect(malformed.status).toBe(400)
    expect((await json(malformed)).error).toMatchObject({ code: 'invalid-json' })

    const oversized = await mutate(harness, 'x'.repeat(WEB_CONFIG_REQUEST_MAX_BYTES + 1))
    expect(oversized.status).toBe(413)

    const exactTemplate = { expectedRevision: 0, mutations: [{ op: 'set', path: ['searchApi', 'model'], value: '' }] }
    const exactBody = JSON.stringify({
      ...exactTemplate,
      mutations: [{
        ...exactTemplate.mutations[0],
        value: 'x'.repeat(WEB_CONFIG_REQUEST_MAX_BYTES - Buffer.byteLength(JSON.stringify(exactTemplate))),
      }],
    })
    expect(Buffer.byteLength(exactBody)).toBe(WEB_CONFIG_REQUEST_MAX_BYTES)
    const exactSized = await mutate(harness, exactBody)
    expect(exactSized.status).toBe(422)
    expect((await json(exactSized)).error).toMatchObject({ code: 'configuration-too-large' })

    const noOrigin = await fetch(`${harness.origin}${WEB_CONFIG_PATH}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 0, mutations: [] }),
    })
    expect(noOrigin.status).toBe(403)

    const crossOrigin = await mutate(
      harness,
      { expectedRevision: 0, mutations: [] },
      { origin: 'http://evil.example' },
    )
    expect(crossOrigin.status).toBe(403)

    const trusted = {
      headers: {
        host: '127.0.0.1:3080',
        origin: 'http://127.0.0.1:3080',
        'sec-fetch-site': 'same-origin',
      },
      socket: { remoteAddress: '::ffff:127.0.0.1' },
    }
    const asRequest = (value: unknown) => value as Parameters<typeof isTrustedWebConfigRequest>[0]
    expect(isTrustedWebConfigRequest(asRequest(trusted), true)).toBe(true)
    expect(isTrustedWebConfigRequest(asRequest({
      ...trusted,
      socket: { remoteAddress: '192.168.1.20' },
    }), true)).toBe(false)
    expect(isTrustedWebConfigRequest(asRequest({
      ...trusted,
      headers: { ...trusted.headers, forwarded: 'for=127.0.0.1' },
    }), true)).toBe(false)
    expect(isTrustedWebConfigRequest(asRequest({
      ...trusted,
      headers: { ...trusted.headers, host: 'example.com:3080', origin: 'http://example.com:3080' },
    }), true)).toBe(false)
  })

  it('accepts the exact multibyte field limit and rejects one character over it', async () => {
    const harness = await createHarness()
    const exactModel = '界'.repeat(WEB_MODEL_MAX_CHARACTERS)
    const accepted = await mutate(harness, {
      expectedRevision: 0,
      mutations: [{ op: 'set', path: ['searchApi', 'model'], value: exactModel }],
    })
    expect(accepted.status).toBe(200)
    const acceptedSnapshot = await json(accepted) as unknown as WebConfigSnapshot
    expect(acceptedSnapshot.value.searchApi.model).toBe(exactModel)

    const rejected = await mutate(harness, {
      expectedRevision: 1,
      mutations: [{ op: 'set', path: ['searchApi', 'model'], value: `${exactModel}界` }],
    })
    expect(rejected.status).toBe(422)
    expect((await json(rejected)).error).toMatchObject({ code: 'configuration-too-large' })
    expect(harness.editor.snapshotDocument()).toMatchObject({
      'search-enhance': { searchApi: { model: exactModel } },
    })
  })

  it('writes credentials one-way, keeps blank values as no-ops, supports unset, and respects writability', async () => {
    const harness = await createHarness()
    const call = async (method: 'PUT' | 'DELETE', body: unknown) => fetch(
      `${harness.origin}${WEB_CREDENTIALS_PATH}`,
      {
        method,
        headers: {
          origin: harness.origin,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(body),
      },
    )

    const blank = await call('PUT', { credential: 'searchApi', value: '' })
    expect(blank.status).toBe(200)
    expect(await blank.json()).toMatchObject({ changed: false })
    expect(harness.credentials.setCalls).toHaveLength(0)
    expect(harness.credentials.values.get('TEST_GROK_SEARCH_KEY')).toBe('fixture-secret-value')

    const replacement = 'replacement-secret-that-must-not-return'
    const written = await call('PUT', { credential: 'searchApi', value: replacement })
    const writtenText = await written.text()
    expect(written.status).toBe(200)
    expect(writtenText).not.toContain(replacement)
    expect(harness.credentials.setCalls).toEqual([{ ref: 'TEST_GROK_SEARCH_KEY', value: replacement }])
    expect(JSON.parse(writtenText)).toMatchObject({
      changed: true,
      credential: 'searchApi',
      state: { configured: true, ref: 'TEST_GROK_SEARCH_KEY' },
    })

    const removed = await call('DELETE', { credential: 'searchApi' })
    expect(removed.status).toBe(200)
    expect(await removed.json()).toMatchObject({ state: { configured: false } })
    expect(harness.credentials.unsetCalls).toEqual(['TEST_GROK_SEARCH_KEY'])

    harness.credentials.values.set('TEST_GROK_SEARCH_KEY', 'environment-secret')
    harness.credentials.readOnly.add('TEST_GROK_SEARCH_KEY')
    const readOnly = await call('PUT', { credential: 'searchApi', value: 'ignored' })
    expect(readOnly.status).toBe(409)
    expect((await json(readOnly)).error).toMatchObject({ code: 'credential-read-only' })
    expect(harness.credentials.values.get('TEST_GROK_SEARCH_KEY')).toBe('environment-secret')
  })

  it('aborts an incomplete body, drains on dispose, removes routes, and remounts without duplicates', async () => {
    const harness = await createHarness()
    const partial = httpRequest(`${harness.origin}${WEB_CONFIG_PATH}`, {
      method: 'PATCH',
      headers: {
        origin: harness.origin,
        'content-type': 'application/json',
      },
    })
    partial.on('error', () => undefined)
    partial.write('{"expectedRevision":0,')
    await new Promise(resolve => setTimeout(resolve, 20))

    await expect(Promise.race([
      harness.owner.dispose(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('dispose did not drain')), 2000)),
    ])).resolves.toBeUndefined()
    partial.destroy()

    expect((await fetch(`${harness.origin}${WEB_CONFIG_PATH}`)).status).toBe(404)
    const remounted = await harness.ctx.plugin(ownerPlugin())
    await vi.waitFor(async () => {
      expect((await fetch(`${harness.origin}${WEB_CONFIG_PATH}`)).status).toBe(200)
    })
    await remounted.dispose()
    expect((await fetch(`${harness.origin}${WEB_CONFIG_PATH}`)).status).toBe(404)
  })
})
