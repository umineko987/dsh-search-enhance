import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { stat, readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
const packageRootIndex = process.argv.indexOf('--package-root')
const packageRoot = packageRootIndex === -1 ? new URL('../', import.meta.url).pathname : resolve(process.argv[packageRootIndex + 1])
const resolutionContext = new Context()
if (packageRootIndex !== -1) {
  const { PluginPackages, createRuntimeResolution, loadProfileDirectory } = await import('@deepseek-ai/dsh-app-boot')
  const profileDir = process.argv[process.argv.indexOf('--profile-dir') + 1]
  const installAnchor = new URL('../package.json', import.meta.url).pathname
  const profile = loadProfileDirectory('research-sdk-smoke', profileDir, installAnchor)
  new PluginPackages(resolutionContext, { resolution: await createRuntimeResolution({ installAnchor, profile, home: process.env.DSH_HOME }) })
}
const { Config } = await import(pathToFileURL(join(packageRoot, 'lib/config.js')).href)
const { startSdkResearch } = await import(pathToFileURL(join(packageRoot, 'lib/research/sdk.js')).href)

const cancel = process.argv.includes('--cancel')
const soft = process.argv.includes('--soft')
let cancelRequest
const report = { conclusions: soft ? [] : [{ statement: 'Fixture evidence supports a limited conclusion.', sources: [{ url: 'https://example.test/primary', excerpt: 'Fixture primary excerpt.', reading: 'summary_only' }] }], limitations: ['Local protocol fixture; no live research.'], stop_reason: soft ? 'budget_exhausted' : 'evidence_limited' }
const requests = []
let serverError
let searchRequests = 0
const server = createServer((request, response) => {
  void (async () => {
    if (request.url === '/v1/models') { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'fixture-search' }] })); return }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    if (request.url === '/v1/chat/completions') {
      assert.equal(request.headers.authorization, 'Bearer fixture-search-key')
      assert.equal(body.model, 'fixture-search')
      searchRequests++
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'Fixture primary excerpt.\nSources:\n- [Primary](https://example.test/primary)' } }] }))
      return
    }
    requests.push(body)
    assert.equal(request.headers['x-api-key'], 'fixture-model-key')
    assert.equal(body.model, 'deepseek-test')
    assert.deepEqual(body.tools.map(tool => tool.name).sort(), ['docs_search', 'search_sources', 'structured_output', 'web_extract', 'web_map', 'web_search'])
    assert.ok(!JSON.stringify(body).includes('PRIVATE_PARENT_CONTEXT'))
    assert.ok(!/PRIVATE_HOST|fixture-model-key|fixture-search-key/.test(JSON.stringify(body)))
    if (cancel) { cancelRequest(); return }
    const retrieval = requests.length === 1
    const paging = !soft && requests.length === 2
    const sourceRef = JSON.stringify(body).match(/src_[A-Za-z0-9_-]{32}/)?.[0]
    if (!retrieval && !soft) { assert.ok(sourceRef); assert.match(JSON.stringify(body), /Fixture primary excerpt/) }
    if (soft && !retrieval) assert.match(JSON.stringify(body), /the retrieval budget has ended/i)
    const toolName = retrieval ? 'web_search' : paging ? 'search_sources' : 'structured_output'
    const args = retrieval ? { query: 'Find primary fixture evidence', profile: 'fact_check' } : paging ? { source_ref: sourceRef } : report
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const data of [
      { type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model: 'deepseek-test', content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'report', name: toolName, input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
      { type: 'message_stop' },
    ]) response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)
    response.end()
  })().catch(error => { serverError = error; response.writeHead(500).end() })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const ctx = new Context()
let child
try {
  new SessionProjectionRegistry(ctx)
  new SessionStore(ctx)
  new AgentRegistry(ctx)
  new SystemPrompt(ctx, {})
  new ToolRuntime(ctx, {})
  new LlmRuntime(ctx)
  new AgentLoop(ctx, { agents: [] })
  new SubagentRuntime(ctx, { maxDepth: { get: () => 1 }, maxActiveSubagents: { get: () => 4 } })
  ctx.tools.register(defineTool({ name: 'host_extra_tool', description: 'PRIVATE_HOST_TOOL', parameters: {}, output: { schema: { type: 'string' }, render: () => [] }, execute: async () => 'PRIVATE_HOST_TOOL' }))
  ctx.systemPrompt.section({ name: 'arbitrary-plugin-name', order: 0, text: 'PRIVATE_HOST_PROMPT', complete: true })
  ctx.on('llm/stream', () => { throw new Error('Research must not use host LLM middleware') })
  ctx.provide('credentials', { resolve: async ref => { assert.equal(ref, 'FIXTURE_SEARCH_KEY'); return { source: 'fixture', value: 'fixture-search-key' } } })
  const parent = await ctx.agents.create({ sessionId: SessionId('sdk-smoke-parent'), agentOptions: { provider: 'deepseek-official', model: 'deepseek-test' } })
  parent.agent.session.append('tool/call', { turn: 1, step: 1, callId: 'private-parent', name: 'bash', arguments: 'PRIVATE_PARENT_CONTEXT' })
  const controller = new AbortController()
  cancelRequest = () => controller.abort(new Error('fixture caller cancellation'))
  const timer = setTimeout(() => controller.abort(new Error('SDK smoke deadline')), 30000)
  try {
    const start = Date.now()
    child = await startSdkResearch(ctx, {
      parent: parent.agent, query: 'Return a limited fixture report.', route: { provider: 'deepseek-official', model: 'deepseek-test', reasoningEffort: 'off' },
      signal: controller.signal, callerSignal: controller.signal, auth: async () => ({ 'x-api-key': 'fixture-model-key' }),
      bootstrap: { config: Config({ searchApi: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture-search', credentialRef: 'FIXTURE_SEARCH_KEY' }, supplementalSearch: { enabled: false } }), model: { provider: 'deepseek-official', connection: resolveAdapterOptions({ baseURL: `http://127.0.0.1:${server.address().port}/anthropic`, thinking: 'disabled' }) }, timeoutMs: 60000, finishMs: 12000, softDeadline: soft ? start - 1 : start + 48000, hardDeadline: start + 60000 },
    })
    const result = await child.run.result
    if (serverError) throw serverError
    assert.equal(result.stopReason, cancel ? 'aborted' : 'completed', JSON.stringify(result))
    if (cancel) assert.equal(child.bridge.report(), undefined)
    else {
      await Promise.race([child.bridge.finished, new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }))])
      assert.deepEqual(child.bridge.report(), report)
    }
    assert.ok(requests.length > 0)
    assert.equal(searchRequests, soft || cancel ? 0 : 1)
    const profileText = await readFile(join(child.home, 'profiles', 'search-enhance-research', 'cordis.patch.yml'), 'utf8')
    assert.ok(!/fixture-search-key|fixture-model-key|PRIVATE_HOST/.test(profileText))
    assert.ok(child.bridge.pid() && child.bridge.pid() !== process.pid)
    const pid = child.bridge.pid(), home = child.home
    await child.dispose()
    child = undefined
    await assert.rejects(stat(home), { code: 'ENOENT' })
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    assert.deepEqual(ctx.subagents.list(), [])
    console.log('isolated research SDK subprocess: ok')
  } finally { clearTimeout(timer) }
} finally {
  await child?.dispose()
  await ctx.fiber.dispose()
  await resolutionContext.fiber.dispose()
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
}
