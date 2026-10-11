import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { LlmRuntime, ToolCallId } from '@deepseek-ai/dsh-llm'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { Config } from '../lib/config.js'
import { ResearchExecutor } from '../lib/research/executor.js'
import { ForegroundOperationScope } from '../lib/tools/operations.js'
import { createWebResearchTool } from '../lib/tools/web-research.js'

// Runs the official run_code bridge; the programs in this fixture are controlled.
class FixturePtcRuntime extends PtcRuntime {
  language = 'typescript'
  isolation = 'test'
  resolve(request) { return { ...request, cwd: process.cwd(), timeoutMs: null } }
  async run(spec) {
    const functions = spec.bindings.find(binding => binding.global === 'tools').functions
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
    try { return { value: await new AsyncFunction('tools', spec.program)(functions), logs: [] } }
    catch (error) { return { error: { kind: 'exception', message: String(error) }, logs: [] } }
  }
}
const prefix = 'dsh-search-enhance-research-'
const before = new Set((await readdir(tmpdir())).filter(name => name.startsWith(prefix)))
const homes = new Set()
const requests = new Set()
const expected = marker => ({ conclusions: [], limitations: [`No evidence available for ${marker}.`], stop_reason: 'evidence_limited' })
let serverError
let cancelWork
const server = createServer((request, response) => {
  void (async () => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    assert.equal(request.headers['x-api-key'], 'fixture-model-key')
    assert.equal(body.model, 'deepseek-test')
    assert.deepEqual(body.tools.map(tool => tool.name).sort(), ['docs_search', 'search_sources', 'structured_output', 'web_extract', 'web_map', 'web_search'])
    assert.ok(!/PRIVATE_HOST|fixture-model-key/.test(JSON.stringify(body)))
    const marker = JSON.stringify(body).match(/task-(native|ptc|unload)/)?.[0]
    assert.ok(marker)
    requests.add(marker)
    for (const name of await readdir(tmpdir())) if (name.startsWith(prefix) && !before.has(name)) homes.add(join(tmpdir(), name))
    if (marker === 'task-unload') { cancelWork(); return }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const data of [
      { type: 'message_start', message: { id: marker, type: 'message', role: 'assistant', model: 'deepseek-test', content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: marker, name: 'structured_output', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(expected(marker)) } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
      { type: 'message_stop' },
    ]) response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)
    response.end()
  })().catch(error => { serverError = error; response.writeHead(500).end() })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const ctx = new Context()
const operations = new ForegroundOperationScope()
const cwd = process.cwd()
const hostDir = await mkdtemp(join(tmpdir(), 'research host with spaces '))
try {
  await writeFile(join(hostDir, '.env'), 'DEEPSEEK_API_KEY=PRIVATE_HOST_ENV\n')
  process.chdir(hostDir)
  new SessionProjectionRegistry(ctx)
  new SessionStore(ctx)
  new Persistence(ctx, { root: hostDir, compression: 'none' })
  new SessionQuery(ctx)
  new AgentRegistry(ctx)
  new SystemPrompt(ctx, {})
  new FixturePtcRuntime(ctx)
  const runtime = new ToolRuntime(ctx, { mode: 'ptc' })
  new LlmRuntime(ctx)
  new AgentLoop(ctx, { agents: [] })
  new SubagentRuntime(ctx, { maxDepth: { get: () => 1 }, maxActiveSubagents: { get: () => 4 } })
  ctx.llm.registerConfigurableProviders([{ provider: 'deepseek-official', displayName: 'Fixture', settingsNs: 'fixture-model', settingsPath: [] }])
  ctx.provide('configEditor', { configuration: () => [{ entry: { options: { id: 'fixture-model', name: '@deepseek-ai/dsh-llm-deepseek-api-key' } }, inherited: { baseURL: `http://127.0.0.1:${server.address().port}/anthropic`, thinking: 'disabled' }, override: { apiKeyEnv: 'FIXTURE_MODEL_KEY' } }] })
  ctx.provide('credentials', { resolve: async ref => { assert.equal(ref, 'FIXTURE_MODEL_KEY'); return { value: 'fixture-model-key' } } })
  ctx.on('llm/stream', () => { throw new Error('PRIVATE_HOST_MIDDLEWARE must not execute') })
  ctx.systemPrompt.section({ name: 'host-extension', order: 0, complete: true, text: 'PRIVATE_HOST_PROMPT' })
  const research = new ResearchExecutor(ctx, () => Config({ supplementalSearch: { enabled: false } }))
  ctx.tools.register(createWebResearchTool({ research, operations }))
  const parent = (await ctx.agents.create({ sessionId: SessionId('tool-sdk-parent'), agentOptions: { provider: 'deepseek-official', model: 'deepseek-test', reasoningEffort: 'off' } })).agent
  parent.ctx.tools.presentAs('native')
  const ptcParent = (await ctx.agents.create({ sessionId: SessionId('tool-sdk-ptc-parent'), agentOptions: { provider: 'deepseek-official', model: 'deepseek-test', reasoningEffort: 'off' } })).agent
  parent.session.append('turn/start', { turn: 1 })
  ptcParent.session.append('turn/start', { turn: 1 })
  const call = (name, args, id) => runtime.execute({ name, arguments: args, agent: name === 'run_code' ? ptcParent : parent, callId: ToolCallId(id), signal: AbortSignal.timeout(30000) })
  const [native, ptc] = await Promise.all([
    call('web_research', { query: 'task-native', timeout_ms: 60000 }, 'native'),
    call('run_code', { code: 'return await tools.web_research({ query: "task-ptc" })', description: 'fixture research' }, 'ptc'),
  ])
  if (serverError) throw serverError
  assert.ok(!native.isError, JSON.stringify(native))
  assert.ok(!ptc.isError, JSON.stringify(ptc))
  assert.deepEqual(native.value, expected('task-native'))
  assert.match(JSON.stringify(ptc), /No evidence available for task-ptc/)
  assert.deepEqual([...requests].sort(), ['task-native', 'task-ptc'])
  assert.equal(homes.size, 2, 'concurrent invocations must have separate homes')
  cancelWork = () => { research.dispose(); void operations.stop() }
  const unloaded = await call('web_research', { query: 'task-unload', timeout_ms: 60000 }, 'unload')
  assert.equal(unloaded.isError, true)
  await operations.stop()
  for (const [agent, reasons] of [[parent, ['completed', 'aborted']], [ptcParent, ['completed']]]) {
    const entries = await ctx.subagents.listChildren(agent.id)
    assert.equal(entries.length, reasons.length)
    const observed = []
    for (const entry of entries) {
      assert.equal(entry.mode, 'one-shot')
      assert.equal(ctx.agents.get(entry.id), undefined)
      assert.equal(ctx.sessions.get(entry.id), undefined)
      const record = await ctx.sessionQuery.readSession(entry.id)
      observed.push(record.events.findLast(event => event.type === 'turn/end').data.reason.kind)
      assert.ok(!/PRIVATE_HOST|fixture-model-key/.test(JSON.stringify(record)))
    }
    assert.deepEqual(observed.sort(), reasons.sort())
  }
  for (const home of homes) await assert.rejects(stat(home), { code: 'ENOENT' })
  assert.deepEqual(ctx.subagents.list(), [])
  assert.equal(await readFile(join(hostDir, '.env'), 'utf8'), 'DEEPSEEK_API_KEY=PRIVATE_HOST_ENV\n')
  console.log('research public Native/PTC calls, concurrent isolation and unload: ok')
} finally {
  process.chdir(cwd)
  await operations.stop()
  await ctx.fiber.dispose()
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  await rm(hostDir, { recursive: true, force: true })
}
