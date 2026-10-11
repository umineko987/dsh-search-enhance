import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ResearchBootstrap, ResearchSessionBatch } from './protocol.js'
import { validateResearchReport, type ResearchReport } from './report.js'

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** SDK backend doesn't expose its client/events. A per-call authenticated,
 * loopback-only channel carries bootstrap, whitelisted credentials, committed
 * observations and formal reports. It never executes host tools or model requests. */
export async function createResearchBridge(ctx: Context, bootstrap: ResearchBootstrap,
  auth: () => Promise<Record<string, string>>, callerSignal: AbortSignal,
  mirror?: { accept(packet: ResearchSessionBatch): Promise<void> }, workSignal = callerSignal) {
  const token = randomBytes(32).toString('hex')
  const refs = new Set([bootstrap.config.searchApi.credentialRef,
    ...Object.values(bootstrap.config.providers).map(provider => provider.credentialRef)])
  let report: ResearchReport | undefined
  let pid: number | undefined
  let finish!: () => void
  const finished = new Promise<void>(resolve => { finish = resolve })
  const server = createServer((request, response) => {
    void (async () => {
      if (request.headers.authorization !== `Bearer ${token}` || request.headers.origin !== undefined) {
        response.writeHead(403).end(); return
      }
      const path = request.url ?? ''
      // Observation/termination drains remain authorized after work cancellation.
      const observing = request.method === 'POST' && ['/session-events', '/finished'].includes(path)
      if (!observing) {
        callerSignal.throwIfAborted()
        if (path !== '/report') workSignal.throwIfAborted()
      }
      let value: unknown
      if (request.method === 'GET' && path === '/bootstrap') value = bootstrap
      else if (request.method === 'GET' && path === '/model-auth') value = await auth()
      else if (request.method === 'GET' && path.startsWith('/credential/')) {
        const ref = credentialRef(decodeURIComponent(path.slice('/credential/'.length)))
        if (!refs.has(ref)) { response.writeHead(403).end(); return }
        value = await ctx.credentials.resolve(ref) ?? null
      } else if (request.method === 'POST' && path === '/report') {
        const payload = await body(request) as { acceptedAt: number; report: unknown }
        if (!Number.isSafeInteger(payload.acceptedAt) || payload.acceptedAt > bootstrap.hardDeadline || payload.acceptedAt > Date.now()) {
          throw new Error('Report was not accepted within the research budget')
        }
        const parsed = validateResearchReport(payload.report)
        if (payload.acceptedAt >= bootstrap.softDeadline && parsed.stop_reason !== 'budget_exhausted') throw new Error('Report must explain budget exhaustion')
        callerSignal.throwIfAborted()
        report ??= parsed
        value = { accepted: true }
      } else if (request.method === 'POST' && path === '/ready') {
        pid = (await body(request) as { pid: number }).pid
        value = {}
      } else if (request.method === 'POST' && path === '/session-events') {
        if (mirror) await mirror.accept(await body(request) as ResearchSessionBatch)
        else { response.writeHead(404).end(); return }
        value = {}
      } else if (request.method === 'POST' && path === '/finished') {
        finish(); value = {}
      } else { response.writeHead(404).end(); return }
      if (!observing) {
        callerSignal.throwIfAborted()
        if (path !== '/report') workSignal.throwIfAborted()
      }
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value))
    })().catch(() => { response.writeHead(400).end(JSON.stringify({ error: 'Research channel request failed' })) })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address() as { port: number }
  return {
    env: { DSH_RESEARCH_CHANNEL: `http://127.0.0.1:${address.port}`, DSH_RESEARCH_TOKEN: token },
    finished,
    report: () => report,
    pid: () => pid,
    dispose: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
    }),
  }
}
