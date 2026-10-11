import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { createUserMessage, resolveRetryPolicy, type UserMessage } from '@deepseek-ai/dsh-llm'
import { registerDeepSeekProvider } from '@deepseek-ai/dsh-llm-deepseek'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { createSearchServices } from '../tools/services.js'
import { createResearchPersona } from './persona.js'
import { FINISH_NOTICE, RESEARCH_RETRIEVAL_TOOLS, type ResearchBootstrap } from './protocol.js'
import { RESEARCH_REPORT_OUTPUT_SCHEMA, validateResearchReport, type ResearchReport } from './report.js'
import { observeResearchSession } from './session-observer.js'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'web-research-budget': { kind: 'web-research-budget'; budget: 'time' }
  }
}

export const name = 'search-enhance-research-child'
export const inject = ['agents', 'llm', 'storageDomain', 'systemPrompt', 'tools']

export async function apply(ctx: Context): Promise<void> {
  const channel = process.env.DSH_RESEARCH_CHANNEL!
  const token = process.env.DSH_RESEARCH_TOKEN!
  // Only in-memory capabilities. Never include them in profile, prompt or log.
  delete process.env.DSH_RESEARCH_TOKEN
  delete process.env.DSH_RESEARCH_CHANNEL
  const lifetime = new AbortController()
  const call = async (path: string, payload?: unknown, signal = lifetime.signal) => {
    const response = await fetch(`${channel}${path}`, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal,
    })
    if (!response.ok) throw new Error('Research channel unavailable')
    return response.json()
  }
  const bootstrap = await call('/bootstrap') as ResearchBootstrap
  const observation = observeResearchSession(ctx, bootstrap.session, payload =>
    call('/session-events', payload, AbortSignal.any([lifetime.signal, AbortSignal.timeout(2000)])))
  // No ambient .env discovery, file store, or arbitrary host credential access.
  ctx.provide('credentials', { resolve: (ref: ReturnType<typeof credentialRef>) => call(`/credential/${encodeURIComponent(ref)}`).then(value => value ?? undefined) } as CredentialProvider)
  const connection = {
    ...bootstrap.model.connection,
    retryPolicy: resolveRetryPolicy({
      mode: 'normal', maxRetries: 2, retryableCodes: ['MALFORMED_RESPONSE'],
    }, 'web_research retryPolicy'),
  }
  registerDeepSeekProvider(ctx, bootstrap.model.provider, {
    options: () => connection,
    resolveAuth: async () => ({ headers: await call('/model-auth') as Record<string, string> }),
  })
  const { tools } = await createSearchServices(ctx, bootstrap.config)
  for (const tool of Object.values(tools)) ctx.tools.register(tool)
  ctx.systemPrompt.section({ name: 'research:persona', order: 0, text: createResearchPersona(bootstrap.timeoutMs, bootstrap.finishMs) })

  let accepted: ResearchReport | undefined
  let delivery: Promise<unknown> = Promise.resolve()
  const staged = new WeakMap<Readonly<ToolExecution>, ResearchReport>()
  ctx.tools.register(defineTool({
    name: 'structured_output', description: 'Formally submit the final research report. Plain assistant text does not count.',
    parameters: RESEARCH_REPORT_OUTPUT_SCHEMA.properties,
    output: { schema: { type: 'object', additionalProperties: false, properties: { recorded: { type: 'boolean', required: true } } }, render: () => [{ type: 'text', text: 'Structured output recorded.' }] },
    async execute(args, exec) {
      const report = validateResearchReport(args)
      if (Date.now() >= bootstrap.softDeadline && report.stop_reason !== 'budget_exhausted') throw new Error(FINISH_NOTICE)
      staged.set(exec, report)
      exec.concludeTurn()
      return { recorded: true }
    },
  }))
  ctx.on('tools/result', (exec, result) => {
    const report = staged.get(exec)
    staged.delete(exec)
    const acceptedAt = Date.now()
    if (report !== undefined && !result.isError && acceptedAt <= bootstrap.hardDeadline) {
      accepted = report
      delivery = call('/report', { report, acceptedAt })
      // The parent observes the formal submission, not the tool body's staged value.
      void delivery.catch(() => undefined)
    }
    return undefined
  })
  const denial = (exec: Readonly<ToolExecution>) => {
    if (accepted !== undefined) return 'Research report already accepted; the run is complete'
    if (Date.now() >= bootstrap.hardDeadline) return 'Research time budget exceeded'
    if (Date.now() >= bootstrap.softDeadline && RESEARCH_RETRIEVAL_TOOLS.has(exec.name)) return FINISH_NOTICE
    return undefined
  }
  ctx.tools.guard(denial)
  ctx.on('tools/execute', (exec, next) => {
    const reason = denial(exec)
    if (reason !== undefined) throw new Error(reason)
    return next()
  })
  ctx.on('agent/created', ({ agent }) => {
    let notice: UserMessage | undefined
    let delivered = false
    const finish = () => {
      if (notice !== undefined || accepted !== undefined) return
      notice = createUserMessage({ content: [{ type: 'text', text: FINISH_NOTICE }], source: { kind: 'web-research-budget', budget: 'time' } })
      agent.inject(notice)
    }
    const timer = setTimeout(finish, Math.max(0, bootstrap.softDeadline - Date.now()))
    timer.unref()
    agent.ctx.effect(() => () => clearTimeout(timer))
    agent.ctx.on('agent/pre-step', async (_payload, next) => {
      if (Date.now() >= bootstrap.softDeadline) finish()
      const decision = await next()
      if (decision.kind !== 'enter' || notice === undefined || delivered) return decision
      delivered = true
      agent.inbox.remove(notice.id)
      return { ...decision, messages: decision.messages.some(message => message.id === notice!.id) ? decision.messages : [...decision.messages, notice] }
    })
    return undefined
  })
  ctx.on('agent/status', ({ status }) => {
    if (status === 'idle') {
      delivery = delivery.then(async () => { await observation.drain(); return call('/finished', {}) })
      void delivery.catch(() => undefined)
    }
  })
  ctx.effect(() => async () => {
    // EOF/shutdown drains a formally captured submission before killing the channel.
    try { await delivery } finally { await observation.drain(); lifetime.abort() }
  })
  await call('/ready', { pid: process.pid })
}
