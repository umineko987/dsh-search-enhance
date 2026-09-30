import assert from 'node:assert/strict'
import { lstat, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { boot, initProfile, readProfilePatches } from '@deepseek-ai/dsh-app-boot'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const home = await mkdtemp(join(tmpdir(), 'dsh-search-enhance-profile-'))
const profile = join(home, 'profiles', 'test')
const configPath = join(home, 'cordis.yml')
const selfLink = join(root, 'node_modules', 'dsh-search-enhance')
const previousHome = process.env.DSH_HOME
let linked = false
let ctx

process.env.DSH_HOME = home
try {
  try {
    await lstat(selfLink)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await symlink(root, selfLink, 'junction')
    linked = true
  }
  initProfile(profile, [])
  const configured = `- id: storage
  name: '@deepseek-ai/dsh-storage'
- id: storage-json
  name: '@deepseek-ai/dsh-storage-json'
  config:
    root: ${JSON.stringify(join(home, 'storage'))}
- id: storage-domain
  name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
- id: sessions
  name: '@deepseek-ai/dsh-session'
- id: agents
  name: '@deepseek-ai/dsh-agent'
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
- id: tools
  name: '@deepseek-ai/dsh-tools'
  config:
    mode: native
- id: credentials
  name: '@deepseek-ai/dsh-credentials-local'
  config:
    watch: false
- id: config-editor
  name: '@deepseek-ai/dsh-config-editor'
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: 127.0.0.1
    port: 0
- id: search-enhance
  name: 'dsh-search-enhance'
  config:
    searchApi:
      baseUrl: https://grok-gateway.example/v1
      protocol: completions
      model: grok-4.20-beta
    providers:
      context7:
        baseUrl: https://context7.example/v1
    futureField:
      keep: true`
  await writeFile(configPath, '[]\n')
  await symlink(join(root, 'node_modules'), join(home, 'node_modules'), 'junction')
  const profileContext = {
    name: 'test', dir: profile, patchPath: join(profile, 'cordis.patch.yml'),
    installAnchor: join(root, 'package.json'), cwd: root, home,
    startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  }
  await writeFile(profileContext.patchPath, `- insert:\n${configured.trimEnd().split('\n').map(line => `    ${line}`).join('\n')}\n`)
  ctx = await boot('dsh-search-enhance-profile-smoke', configPath,
    readProfilePatches('dsh', profileContext),
    host => { host.provide('profileContext', profileContext) },
    pathToFileURL(join(root, 'package.json')).href)
  await ctx.loader.await()
  assert.ok(ctx.get('configEditor'), 'ConfigEditor was not mounted')
  const entry = [...ctx.loader.entries()].find(row => row.options.id === 'search-enhance')
  assert.ok(entry?.fiber)
  await entry.fiber.await()
  const origin = `http://127.0.0.1:${ctx.webServer.port}`
  const endpoint = `${origin}/dsh-search-enhance/config`
  const first = await fetch(endpoint)
  assert.equal(first.status, 200)
  const before = await first.json()
  assert.equal(before.value.searchApi.model, 'grok-4.20-beta')
  assert.equal(before.applies, 'live')
  assert.equal(before.base.searchApi.model, 'grok-4.20-beta')
  assert.equal(before.user?.searchApi?.model, undefined)
  const toolNames = ctx.tools.schemas().map(schema => schema.name)
  assert.deepEqual(toolNames, ['docs_search', 'web_extract', 'search_tools'])
  const patched = await fetch(endpoint, {
    method: 'PATCH',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: before.revision,
      mutations: [
        { op: 'set', path: ['searchApi', 'model'], value: 'grok-third-party-next' },
        { op: 'set', path: ['toolDiscovery', 'mode'], value: 'all' },
      ] }),
  })
  assert.equal(patched.status, 200, await patched.text())
  const after = await fetch(endpoint)
  assert.equal(after.status, 200)
  const persisted = await after.json()
  assert.equal(persisted.value.searchApi.model, 'grok-third-party-next')
  assert.equal(entry.fiber.config.searchApi.model, 'grok-third-party-next', 'active plugin must use the saved config')
  assert.equal(entry.fiber.config.toolDiscovery.mode, 'all')
  assert.equal(persisted.revision, 1, 'configuration revision must remain monotonic after reload')
  assert.deepEqual(ctx.tools.schemas().map(schema => schema.name), toolNames)
  assert.equal(persisted.user.searchApi.model, 'grok-third-party-next')
  assert.equal(persisted.user.searchApi.thinkingLevel, undefined)
  const stale = await fetch(endpoint, {
    method: 'PATCH',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0,
      mutations: [{ op: 'set', path: ['searchApi', 'model'], value: 'lost-write' }] }),
  })
  assert.equal(stale.status, 409)
  const rejected = await fetch(endpoint, {
    method: 'PATCH',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 1,
      mutations: [{ op: 'set', path: ['searchApi', 'protocol'], value: 'invalid' }] }),
  })
  assert.equal(rejected.status, 422)
  assert.equal((await (await fetch(endpoint)).json()).value.searchApi.model, 'grok-third-party-next')
  const patch = await readFile(profileContext.patchPath, 'utf8')
  assert.match(patch, /grok-third-party-next/u)
  assert.match(patch, /https:\/\/context7\.example\/v1/u)
  assert.match(patch, /keep: true/u)
  console.log('profile config editor loader: ok')
} finally {
  await ctx?.fiber.dispose()
  if (linked) await unlink(selfLink)
  await rm(home, { recursive: true, force: true })
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
}
