import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { LlmRuntime, createUserMessage } from '@deepseek-ai/dsh-llm'
import { resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { Config } from '../lib/config.js'
import { startSdkResearch } from '../lib/research/sdk.js'

// With no mode, run every cross-process case in its own clean host runtime.
if (!process.argv[2]) {
  for (const mode of ['complete', 'concurrent', 'cancel', 'hard', 'hmr', 'error', 'kill', 'display-error-complete', 'display-error-cancel']) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), mode], { stdio: 'inherit' })
    const [code] = await once(child, 'exit')
    assert.equal(code, 0, `Research session fixture failed: ${mode}`)
  }
  process.exit(0)
}

const scenario = process.argv[2] ?? 'complete'
const displayError = scenario.startsWith('display-error-')
const mode = displayError ? scenario.slice('display-error-'.length) : scenario
const count = mode === 'concurrent' ? 2 : 1
const root = await mkdtemp(join(tmpdir(), 'research-session-test-'))
const gate = Promise.withResolvers()
const reached = Promise.withResolvers()
const steps = new Map()
let serverError
const requests = []
const report = label => ({ conclusions: [{ statement: `${label} limited fixture conclusion`, sources: [{ url: `https://example.test/${label}`, excerpt: `${label} primary evidence`, reading: 'summary_only' }] }], limitations: ['Local fixture only.'], stop_reason: 'evidence_limited' })
const server = createServer((request, response) => {
  void (async () => {
    if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'fixture-search' }] })); return }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const label = JSON.stringify(body).includes('topic-B') ? 'topic-B' : 'topic-A'
    if (request.url === '/v1/chat/completions') {
      assert.equal(request.headers.authorization, 'Bearer fixture-search-key')
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: `${label} primary evidence\nSources:\n- [Primary](https://example.test/${label})` } }] }))
      return
    }
    assert.equal(request.headers['x-api-key'], 'fixture-model-key')
    assert.deepEqual(body.tools.map(tool => tool.name).sort(), ['docs_search', 'search_sources', 'structured_output', 'web_extract', 'web_map', 'web_search'])
    assert.ok(!/PRIVATE_HOST|PRIVATE_PARENT|fixture-model-key|fixture-search-key/.test(JSON.stringify(body)))
    requests.push(body)
    const step = (steps.get(label) ?? 0) + 1
    steps.set(label, step)
    if (step === 3) {
      if (steps.size === count && [...steps.values()].every(value => value >= 3)) reached.resolve()
      await gate.promise
      if (mode === 'error') { response.writeHead(400).end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Fixture model failure' } })); return }
      if (['cancel', 'hard', 'hmr', 'kill'].includes(mode)) return
    }
    const sourceRef = JSON.stringify(body).match(/src_[A-Za-z0-9_-]{32}/)?.[0]
    if (step > 1) assert.ok(sourceRef)
    const name = step === 1 ? 'web_search' : step === 2 ? 'search_sources' : 'structured_output'
    const args = step === 1 ? { query: `Find ${label} primary evidence`, profile: 'fact_check' } : step === 2 ? { source_ref: sourceRef } : report(label)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const data of [
      { type: 'message_start', message: { id: `${label}-${step}`, type: 'message', role: 'assistant', model: 'deepseek-test', content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `${label}-call-${step}`, name, input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
      { type: 'message_stop' },
    ]) response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)
    response.end()
  })().catch(error => { serverError = error; reached.reject(error); response.writeHead(500).end() })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const signal = () => new AbortController().signal
const children = [], parents = [], addresses = [], followers = [], frames = []
const ctx = new Context()
const cold = new Context()
const mountRead = context => {
  new SessionProjectionRegistry(context)
  new SessionStore(context)
  new AgentRegistry(context)
  new SessionQuery(context)
  new Persistence(context, { root, compression: 'none' })
  new SubagentRuntime(context, { maxDepth: { get: () => 4 }, maxActiveSubagents: { get: () => 4 } })
  context.provide('typert', { lookups: { configure() {} }, contexts: { configureHost() {} } })
  context.provide('fileUploads', { registerAgentResolver() { return () => {} } })
  new SessionController(context, { nativeOpen: false })
}
const caller = new AbortController(), work = new AbortController()
const timer = setTimeout(() => { caller.abort(new Error('Fixture deadline')); gate.resolve(); reached.reject(new Error('Fixture deadline')) }, 30000)
try {
  mountRead(ctx)
  new SystemPrompt(ctx, {})
  new ToolRuntime(ctx, {})
  new LlmRuntime(ctx)
  new AgentLoop(ctx, { agents: [] })
  ctx.tools.register(defineTool({ name: 'host_extra_tool', description: 'PRIVATE_HOST_TOOL', parameters: {}, output: { schema: { type: 'string' }, render: () => [] }, execute: async () => 'PRIVATE_HOST' }))
  ctx.systemPrompt.section({ name: 'host-only', order: 0, text: 'PRIVATE_HOST_PROMPT', complete: true })
  ctx.on('llm/stream', () => { throw new Error('Host middleware contamination') })
  ctx.provide('credentials', { resolve: async () => ({ source: 'fixture', value: 'fixture-search-key' }) })
  await new Promise(resolve => setImmediate(resolve))
  const start = Date.now()
  for (let i = 0; i < count; i++) {
    const label = i === 0 ? 'topic-A' : 'topic-B'
    const parent = await ctx.agents.create({ sessionId: SessionId(`parent-${label}`), meta: { cwd: root, delegationDepth: 2 }, agentOptions: { provider: 'deepseek-official', model: 'deepseek-test' } })
    parents.push(parent)
    parent.agent.session.append('turn/start', { turn: 1 })
    parent.agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'PRIVATE_PARENT_CONTEXT' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  }
  children.push(...await Promise.all(parents.map((parent, i) => startSdkResearch(ctx, {
    parent: parent.agent, query: `Research topic-${i ? 'B' : 'A'}`, route: { provider: 'deepseek-official', model: 'deepseek-test', reasoningEffort: 'off' },
    signal: AbortSignal.any([caller.signal, work.signal]), callerSignal: caller.signal, auth: async () => ({ 'x-api-key': 'fixture-model-key' }),
    bootstrap: { config: Config({ searchApi: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture-search', credentialRef: 'FIXTURE_SEARCH_KEY' }, supplementalSearch: { enabled: false } }), model: { provider: 'deepseek-official', connection: resolveAdapterOptions({ baseURL: `http://127.0.0.1:${server.address().port}/anthropic`, thinking: 'disabled' }) }, timeoutMs: 60000, finishMs: 12000, softDeadline: start + 48000, hardDeadline: start + 60000 },
  }))))
  for (const parent of parents) {
    let entries = []
    while (!entries.length && !caller.signal.aborted) { entries = await ctx.subagents.listChildren(parent.agent.id); if (!entries.length) await new Promise(resolve => setTimeout(resolve, 10)) }
    const entry = entries[0]
    assert.equal(entries.length, 1)
    assert.equal(entry.label, 'web_research')
    assert.equal(entry.mode, 'one-shot')
    assert.equal(ctx.agents.get(entry.id), undefined)
    const address = { kind: 'subagent', parentSessionId: parent.agent.id, childSessionId: entry.id, mode: 'one-shot' }
    addresses.push(address)
    const controller = new AbortController()
    const collected = []
    frames.push(collected)
    const done = (async () => { for await (const frame of ctx.sessionController.follow({ address, assistantStream: true }, controller.signal)) collected.push(frame) })()
    followers.push({ controller, done })
  }
  await reached.promise
  for (let i = 0; i < count; i++) {
    const address = addresses[i], label = i ? 'topic-B' : 'topic-A'
    const record = await ctx.sessionQuery.readSession(address.childSessionId)
    assert.equal(record.session.parentSession, address.parentSessionId)
    assert.equal(record.session.delegationDepth, 3)
    assert.equal(record.session.cwd, root)
    assert.equal(record.session.isSeeded, false)
    assert.ok(record.events.some(event => event.type === 'tool/call' && event.data.name === 'web_search'))
    assert.ok(record.events.some(event => event.type === 'tool/result' && event.data.message.source.callId === `${label}-call-1`))
    const page = await ctx.sessionController.page({ address, throughSeq: record.events.length - 1, maxMessages: 50 }, signal())
    assert.match(JSON.stringify(page), new RegExp(`${label} primary evidence`))
    assert.ok(!JSON.stringify(page).includes(i ? 'topic-A' : 'topic-B'))
    await assert.rejects(ctx.sessionController.page({ address: { ...address, parentSessionId: SessionId('wrong-parent') }, throughSeq: record.events.length - 1 }, signal()), /belong/)
    await assert.rejects(ctx.sessionController.page({ address: { kind: 'session', sessionId: address.childSessionId }, throughSeq: record.events.length - 1 }, signal()), /parent address/)
    const resolution = await ctx.sessionController.resolveAgent(address.childSessionId)
    assert.ok(resolution.error)
    await assert.rejects(ctx.sessionController.prompt({ sessionId: address.childSessionId, requestId: 'forbidden', mode: 'queue', content: [{ type: 'text', text: 'Continue' }] }, signal()))
    await assert.rejects(ctx.subagents.prompt({ mode: 'continuable', parentSessionId: address.parentSessionId, childSessionId: address.childSessionId, requestId: 'forbidden', delivery: 'queue', content: [{ type: 'text', text: 'Continue' }] }, signal()), /one-shot|continuable|resum/i)
    assert.equal(ctx.agents.get(address.childSessionId), undefined)
  }
  if (mode === 'cancel' || mode === 'hmr') caller.abort(new Error(mode === 'hmr' ? 'web_research executor disposed' : 'fixture caller cancellation'))
  if (mode === 'hard') work.abort(new Error('web_research time budget exceeded'))
  if (mode === 'kill') process.kill(children[0].bridge.pid(), 'SIGKILL')
  gate.resolve()
  const results = await Promise.all(children.map(child => child.run.result))
  if (serverError) throw serverError
  for (let i = 0; i < count; i++) {
    assert.equal(results[i].stopReason, ['cancel', 'hard', 'hmr'].includes(mode) ? 'aborted' : ['error', 'kill'].includes(mode) ? 'error' : 'completed')
    if (['complete', 'concurrent'].includes(mode)) {
      await children[i].bridge.finished
      assert.deepEqual(children[i].bridge.report(), report(i ? 'topic-B' : 'topic-A'))
    } else assert.equal(children[i].bridge.report(), undefined)
    const pid = children[i].bridge.pid(), home = children[i].home
    const stopFailure = displayError ? ctx.on('session/flush', session => {
      if (session.id === addresses[i].childSessionId) throw new Error('Fixture display persistence failure')
    }) : undefined
    try { await children[i].dispose() } finally { stopFailure?.() }
    if (mode === 'complete') assert.deepEqual(children[i].bridge.report(), report(i ? 'topic-B' : 'topic-A'))
    await assert.rejects(stat(home), { code: 'ENOENT' })
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    parents[i].agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessions.flush(parents[i].agent.session)
    const record = await ctx.sessionQuery.readSession(addresses[i].childSessionId)
    const expected = ['cancel', 'hard', 'hmr'].includes(mode) ? 'aborted' : mode === 'kill' ? 'interrupted' : mode === 'error' ? 'error' : 'completed'
    assert.equal(record.events.findLast(event => event.type === 'turn/end').data.reason.kind, expected)
    assert.ok(record.events.every((event, index) => event.seq === index))
    assert.ok(!/fixture-model-key|fixture-search-key|DSH_RESEARCH_TOKEN|PRIVATE_HOST|PRIVATE_PARENT/.test(JSON.stringify(record)))
    assert.equal(ctx.sessions.get(addresses[i].childSessionId), undefined)
    assert.equal(ctx.agents.get(addresses[i].childSessionId), undefined)
    assert.match(JSON.stringify(await ctx.sessionController.page({ address: addresses[i], throughSeq: record.events.length - 1, maxMessages: 50 }, signal())), /primary evidence/)
  }
  for (let i = 0; i < count; i++) {
    await new Promise(resolve => setImmediate(resolve))
    followers[i].controller.abort()
    await followers[i].done
    assert.equal(frames[i][0].type, 'snapshot')
    assert.equal(frames[i][0].projections.values.subagent.mode, 'one-shot')
    const wire = JSON.stringify(frames[i])
    assert.match(wire, /tool\/call/)
    assert.match(wire, /tool\/result/)
    assert.ok(frames[i].some(frame => frame.type === 'event' && frame.event.type === 'tool/result'))
    assert.ok(!frames[i].some(frame => frame.type === 'assistant-stream'))
  }
  assert.deepEqual(ctx.subagents.list(), [])
  await ctx.fiber.dispose()
  mountRead(cold)
  await new Promise(resolve => setImmediate(resolve))
  for (const address of addresses) {
    const entries = await cold.subagents.listChildren(address.parentSessionId)
    assert.equal(entries[0].id, address.childSessionId)
    assert.equal(entries[0].mode, 'one-shot')
    const record = await cold.sessionQuery.readSession(address.childSessionId)
    assert.match(JSON.stringify(await cold.sessionController.page({ address, throughSeq: record.events.length - 1, maxMessages: 50 }, signal())), /primary evidence/)
    assert.equal(cold.agents.get(address.childSessionId), undefined)
    assert.ok((await cold.sessionController.resolveAgent(address.childSessionId)).error)
  }
  console.log(`research session SDK ${scenario}: native catalog/follow/page, read-only, isolation, cleanup and restart cold-read ok (${requests.length} fixture model requests)`)
} finally {
  clearTimeout(timer)
  gate.resolve()
  for (const follower of followers) { follower.controller.abort(); await follower.done.catch(() => {}) }
  for (const child of children) await child.dispose().catch(() => {})
  await ctx.fiber.dispose()
  await cold.fiber.dispose()
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  await rm(root, { recursive: true, force: true })
}
