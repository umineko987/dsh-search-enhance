import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Config, type Config as ConfigValue } from '../src/config.js'
import { DirectFetchProvider } from '../src/providers/direct-fetch.js'
import { SmartDirectProvider } from '../src/providers/smart-direct.js'
import {
  WebExtractInfrastructureError,
  WebExtractOrchestrator,
  type WebExtractAdapter,
  type WebExtractAdapterOutcome,
  type WebExtractRoute,
} from '../src/web-extract/index.js'
import {
  createHttpProxyFixture,
  PROXY_REJECTION_SECRET,
} from './proxy-fixture.js'

interface Fixture {
  readonly origin: string
  readonly sockets: ReadonlySet<Socket>
  close(): Promise<void>
}

const fixtures: Fixture[] = []

async function fixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<Fixture> {
  const sockets = new Set<Socket>()
  const server = createServer(handler)
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  const value: Fixture = {
    origin: `http://127.0.0.1:${address.port}`,
    sockets,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => {
        server.close(error => error === undefined ? resolve() : reject(error))
      })
    },
  }
  fixtures.push(value)
  return value
}

afterEach(async () => {
  vi.restoreAllMocks()
  while (fixtures.length > 0) await fixtures.pop()?.close()
})

function articleHtml(): string {
  return '<!doctype html><html><head><title>Smart chain title</title><meta name="author" content="Ada"><meta property="article:published_time" content="2026-08-15"><link rel="canonical" href="/canonical"></head><body><article><h1>Smart chain title</h1><p>The production smart route extracts this deterministic article with enough useful words for Defuddle.</p><p>A second paragraph keeps the result stable and readable.</p></article></body></html>'
}

function stub(
  route: WebExtractRoute,
  outcome: WebExtractAdapterOutcome | (() => Promise<WebExtractAdapterOutcome>),
  supports = true,
): WebExtractAdapter {
  return {
    route,
    enabled: () => true,
    supports: () => supports,
    extract: typeof outcome === 'function' ? outcome : async () => outcome,
  }
}

function orchestrator(input: {
  readonly tavily?: WebExtractAdapter
  readonly firecrawl?: WebExtractAdapter
  readonly smart?: WebExtractAdapter
  readonly direct?: WebExtractAdapter
  readonly config?: ConfigValue
}): WebExtractOrchestrator {
  return new WebExtractOrchestrator({
    tavilyExtract: input.tavily ?? stub('tavily_extract', { state: 'not_configured' }),
    firecrawlScrape: input.firecrawl ?? stub('firecrawl_scrape', { state: 'not_configured' }),
    smartDirect: input.smart ?? new SmartDirectProvider(),
    direct: input.direct ?? new DirectFetchProvider(),
    getConfig: () => input.config ?? Config({} as never),
    now: () => 100,
  })
}

describe('explicit production extraction Providers', () => {
  it('returns smart_direct extracted evidence without invoking remote or direct Providers', async () => {
    const page = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(articleHtml())
    })
    const direct = new DirectFetchProvider()
    const directExtract = vi.spyOn(direct, 'extract')
    const remote = vi.fn(async (): Promise<WebExtractAdapterOutcome> => { throw new Error('must not run') })
    const result = await orchestrator({ direct, tavily: stub('tavily_extract', remote), firecrawl: stub('firecrawl_scrape', remote) }).extract({
      provider: 'smart_direct', format: 'markdown', signal: new AbortController().signal, url: `${page.origin}/article`,
    })
    expect(result).toMatchObject({
      author: 'Ada', canonicalUrl: `${page.origin}/canonical`, evidenceLevel: 'extracted_content',
      publishedAt: '2026-08-15', retrievalRoute: 'smart_direct', title: 'Smart chain title', truncated: false,
    })
    expect(result.content).toContain('production smart route')
    expect(result.attempts).toHaveLength(1)
    expect(result.attempts[0]).toMatchObject({ provider: 'smart_direct', outcome: 'success', participatedInFallback: false })
    expect(remote).not.toHaveBeenCalled()
    expect(directExtract).not.toHaveBeenCalled()
  })

  it.each(['smart_direct', 'direct'] as const)('uses only the independently configured proxy for %s', async provider => {
    const page = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(articleHtml())
    })
    const smartProxy = await createHttpProxyFixture()
    const directProxy = await createHttpProxyFixture()
    fixtures.push(smartProxy, directProxy)
    const target = `http://independent-origin.invalid:${new URL(page.origin).port}/article`
    const config = Config({ webExtract: { smartDirect: { proxyUrl: smartProxy.origin }, direct: { proxyUrl: directProxy.origin } } } as never)
    const result = await orchestrator({ config }).extract({ provider, url: target, format: 'text', signal: new AbortController().signal })
    expect(result.retrievalRoute).toBe(provider)
    expect(smartProxy.requests).toEqual(provider === 'smart_direct' ? [target] : [])
    expect(directProxy.requests).toEqual(provider === 'direct' ? [target] : [])
  })

  it.each(['smart_direct', 'direct'] as const)('redacts %s proxy authentication failures without switching providers', async provider => {
    const smartProxy = await createHttpProxyFixture({ rejectHttp: true })
    const directProxy = await createHttpProxyFixture({ rejectHttp: true })
    fixtures.push(smartProxy, directProxy)
    const config = Config({ webExtract: {
      smartDirect: { maxRetries: 0, proxyUrl: smartProxy.origin },
      direct: { maxRetries: 0, proxyUrl: directProxy.origin },
    } } as never)
    const error = await orchestrator({ config }).extract({ provider, url: 'http://proxy-auth-rejected.invalid/article', format: 'text', signal: new AbortController().signal }).catch(error => error)
    expect(error).toBeInstanceOf(WebExtractInfrastructureError)
    expect(error.routeStatuses).toEqual([expect.objectContaining({ attempts: 1, errorKind: 'http', httpStatus: 407, outcome: 'failed', provider })])
    expect(JSON.stringify(error)).not.toContain(PROXY_REJECTION_SECRET)
    expect((provider === 'smart_direct' ? directProxy : smartProxy).requests).toEqual([])
  })

  it('does not switch to direct after empty SmartDirect extraction', async () => {
    let requests = 0
    const page = await fixture((_request, response) => {
      requests += 1
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<html><head><title>Empty</title></head><body><nav>Only noise</nav></body></html>')
    })
    await expect(orchestrator({}).extract({ provider: 'smart_direct', url: `${page.origin}/empty`, signal: new AbortController().signal })).rejects.toBeInstanceOf(WebExtractInfrastructureError)
    expect(requests).toBe(1)
  })

  it.each(['json', 'raw'] as const)('rejects unsupported SmartDirect %s without dispatch', async format => {
    const smart = new SmartDirectProvider()
    const direct = new DirectFetchProvider()
    const smartExtract = vi.spyOn(smart, 'extract')
    const directExtract = vi.spyOn(direct, 'extract')
    await expect(orchestrator({ smart, direct }).extract({ provider: 'smart_direct', format, url: 'https://example.test/', signal: new AbortController().signal })).rejects.toMatchObject({
      routeStatuses: [expect.objectContaining({ attempts: 0, provider: 'smart_direct', skipReason: 'format_unsupported' })],
    })
    expect(smartExtract).not.toHaveBeenCalled()
    expect(directExtract).not.toHaveBeenCalled()
  })

  it.each(['smart_direct', 'direct'] as const)('returns a safe failure from %s challenge headers without fallback', async provider => {
    let requests = 0
    const page = await fixture((_request, response) => {
      requests += 1
      response.writeHead(200, { 'cf-mitigated': 'challenge', 'content-type': 'text/html' })
      response.end('<html><body>anti-bot-response-secret</body></html>')
    })
    const error = await orchestrator({}).extract({ provider, url: `${page.origin}/challenge?token=anti-bot-url-secret`, signal: new AbortController().signal }).catch(error => error)
    expect(error).toBeInstanceOf(WebExtractInfrastructureError)
    expect(error.routeStatuses).toEqual([expect.objectContaining({ errorKind: 'unavailable', outcome: 'failed', provider })])
    expect(`${String(error)}\n${JSON.stringify(error)}`).not.toMatch(/anti-bot-(?:response|url)-secret/)
    expect(requests).toBe(1)
    await vi.waitFor(() => expect(page.sockets.size).toBe(0))
  })

  it('redacts an extractor exception without trying direct', async () => {
    const page = await fixture((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(articleHtml()) })
    const smart = new SmartDirectProvider({ extract: async () => { throw new Error('extractor-secret-message') } })
    const direct = new DirectFetchProvider()
    const directExtract = vi.spyOn(direct, 'extract')
    const error = await orchestrator({ smart, direct }).extract({ provider: 'smart_direct', url: page.origin, signal: new AbortController().signal }).catch(error => error)
    expect(error.routeStatuses).toEqual([expect.objectContaining({ errorKind: 'invalid_response', provider: 'smart_direct' })])
    expect(JSON.stringify(error)).not.toContain('extractor-secret-message')
    expect(directExtract).not.toHaveBeenCalled()
  })
})
