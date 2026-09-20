import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const packageRoot = await realpath(dirname(dirname(fileURLToPath(import.meta.url))))
const profileName = 'web'
const MAX_CAPTURE_BYTES = 1024 * 1024
const COMMAND_TIMEOUT_MS = 180_000
const credentialNames = [
  'SEARCH_API_KEY',
  'CONTEXT7_API_KEY',
  'EXA_API_KEY',
  'TAVILY_API_KEY',
  'FIRECRAWL_API_KEY',
]

async function commandAvailable(command) {
  return new Promise(resolve => {
    const child = spawn(command, ['--version'], {
      cwd: packageRoot,
      env: process.env,
      stdio: 'ignore',
      windowsHide: true,
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    child.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.once('close', code => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

const [hasDsh, hasPnpm] = await Promise.all([
  commandAvailable('dsh'),
  commandAvailable('pnpm'),
])
if (!hasDsh || !hasPnpm) {
  const missing = [
    ...(!hasDsh ? ['dsh'] : []),
    ...(!hasPnpm ? ['pnpm'] : []),
  ]
  process.stdout.write(`bundle install acceptance: skipped (${missing.join(' and ')} not available on PATH)\n`)
  process.exit(0)
}

function appendBounded(current, chunk) {
  const next = current + chunk
  if (Buffer.byteLength(next, 'utf8') > MAX_CAPTURE_BYTES) {
    throw new Error('subprocess output exceeded the install-test capture limit')
  }
  return next
}

async function run(command, args, options) {
  let stdout = ''
  let stderr = ''
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let captureFailure
  child.stdout.on('data', chunk => {
    try {
      stdout = appendBounded(stdout, chunk)
    } catch (error) {
      captureFailure = error
      child.kill('SIGKILL')
    }
  })
  child.stderr.on('data', chunk => {
    try {
      stderr = appendBounded(stderr, chunk)
    } catch (error) {
      captureFailure = error
      child.kill('SIGKILL')
    }
  })

  const result = await new Promise((resolve, reject) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, COMMAND_TIMEOUT_MS)
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, timedOut })
    })
  })
  if (captureFailure !== undefined) throw captureFailure
  if (result.timedOut) throw new Error(`${options.label} timed out`)
  if (result.code !== 0) {
    throw new Error([
      `${options.label} failed (${result.signal ?? `exit ${result.code}`})`,
      stdout.trim().length === 0 ? undefined : `stdout:\n${stdout.trim()}`,
      stderr.trim().length === 0 ? undefined : `stderr:\n${stderr.trim()}`,
    ].filter(Boolean).join('\n'))
  }
  return { stdout, stderr }
}

async function verifyWebStartup(env) {
  const child = spawn('dsh', ['web', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    cwd: packageRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const closed = once(child, 'close')
  let startupTimer
  let output = ''
  try {
    const launchUrl = await new Promise((resolve, reject) => {
      startupTimer = setTimeout(() => reject(new Error(`dsh web startup timed out:\n${output}`)), 30_000)
      child.once('error', reject)
      child.once('exit', code => reject(new Error(`dsh web exited before ready (${code}):\n${output}`)))
      const capture = chunk => {
        output = (output + chunk).slice(-MAX_CAPTURE_BYTES)
        const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\S+)/u.exec(output)
        if (match) resolve(match[1])
      }
      child.stdout.on('data', capture)
      child.stderr.on('data', capture)
    })
    const origin = new URL(launchUrl).origin
    const login = await fetch(launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(5_000) })
    assert.equal(login.status, 303, 'dsh web launch URL did not establish a browser session')
    const cookie = login.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie)
    const headers = { cookie }
    const page = await fetch(origin, { headers, signal: AbortSignal.timeout(5_000) })
    assert.equal(page.status, 200, 'dsh web did not serve its UI')
    assert.match(await page.text(), /dsh-search-enhance/u)
    const config = await fetch(`${origin}/dsh-search-enhance/config`, { headers, signal: AbortSignal.timeout(5_000) })
    assert.equal(config.status, 200, 'Search Enhance settings route did not activate')
    assert.equal((await config.json()).namespace, 'search-enhance')
    assert.equal(child.exitCode, null, 'dsh web exited after serving its UI')
  } finally {
    clearTimeout(startupTimer)
    child.kill('SIGTERM')
    const stopTimer = setTimeout(() => child.kill('SIGKILL'), 5_000)
    try { await closed } finally { clearTimeout(stopTimer) }
  }
}

async function readManifest(profileDir) {
  return JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
}

const dshVersion = await run('dsh', ['--version'], {
  cwd: packageRoot,
  env: process.env,
  label: 'dsh --version',
})
assert.equal(dshVersion.stdout.trim(), '0.1.5-rc.2', 'install acceptance requires DSH 0.1.5-rc.2')

const dshHome = await mkdtemp(join(tmpdir(), 'dsh-search-enhance-install-'))
const profileDir = join(dshHome, 'profiles', profileName)
const childEnvironment = { ...process.env, DSH_HOME: dshHome }
for (const name of credentialNames) delete childEnvironment[name]

try {
  const npmCli = process.env.npm_execpath
  assert.ok(npmCli, 'npm_execpath is unavailable')
  await run(process.execPath, [npmCli, 'run', 'build'], {
    cwd: packageRoot,
    env: childEnvironment,
    label: 'npm run build',
  })

  const packed = await run(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', dshHome], {
    cwd: packageRoot,
    env: childEnvironment,
    label: 'npm pack',
  })
  const [{ filename }] = Object.values(JSON.parse(packed.stdout))
  const tarball = join(dshHome, filename)

  await run('dsh', ['plugin', '--profile', profileName, 'add', tarball], {
    cwd: packageRoot,
    env: childEnvironment,
    label: 'dsh plugin add',
  })

  const installed = await readManifest(profileDir)
  const dependency = installed.dependencies?.['dsh-search-enhance']
  assert.equal(typeof dependency, 'string')
  assert.match(dependency, /^file:.*\.tgz$/u, 'profile dependency is not the packed npm artifact')
  assert.ok(installed.dsh?.profile?.bundles?.includes('dsh-search-enhance'))

  const addedDump = await run('dsh', ['--profile', profileName, '--dump-config'], {
    cwd: packageRoot,
    env: childEnvironment,
    label: 'dsh --dump-config after add',
  })
  const addedConfig = `${addedDump.stdout}\n${addedDump.stderr}`
  assert.match(addedConfig, /^# == dsh-search-enhance(?:\s|$)/m)
  assert.match(addedConfig, /^\s*name:\s*["']?dsh-search-enhance["']?\s*$/m)

  const profileRequire = createRequire(join(profileDir, 'package.json'))
  const resolvedEntry = profileRequire.resolve('dsh-search-enhance')
  const installedRoot = dirname(profileRequire.resolve('dsh-search-enhance/package.json'))
  assert.notEqual(await realpath(installedRoot), packageRoot, 'installation resolved back to the checkout')
  assert.equal(resolvedEntry, join(installedRoot, 'lib/index.js'))
  const resolvedClient = profileRequire.resolve('dsh-search-enhance/client')
  assert.equal(resolvedClient, join(installedRoot, 'client/client.js'))
  assert.match(await readFile(resolvedClient, 'utf8'), /^window\.__ModuleLoader__\.load\(\{\s*id: "dsh-search-enhance"/u)
  const installedPackage = JSON.parse(await readFile(profileRequire.resolve('dsh-search-enhance/package.json'), 'utf8'))
  assert.deepEqual(installedPackage.dsh.client, {
    inject: [
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-settings-plugins',
    ],
    platform: 'web',
  })
  assert.equal(
    await realpath(join(installedRoot, installedPackage.exports['./client'].types)),
    await realpath(join(installedRoot, 'client/types/client/index.d.ts')),
  )

  await verifyWebStartup(childEnvironment)

  await run('dsh', ['plugin', '--profile', profileName, 'remove', 'dsh-search-enhance'], {
    cwd: packageRoot,
    env: childEnvironment,
    label: 'dsh plugin remove',
  })

  const removed = await readManifest(profileDir)
  assert.equal(removed.dependencies?.['dsh-search-enhance'], undefined)
  assert.equal(removed.dsh?.profile?.bundles?.includes('dsh-search-enhance'), false)
  const removedDump = await run('dsh', ['--profile', profileName, '--dump-config'], {
    cwd: packageRoot,
    env: childEnvironment,
    label: 'dsh --dump-config after remove',
  })
  const removedConfig = `${removedDump.stdout}\n${removedDump.stderr}`
  assert.doesNotMatch(removedConfig, /^# == dsh-search-enhance(?:\s|$)/m)
  assert.doesNotMatch(removedConfig, /^\s*name:\s*["']?dsh-search-enhance["']?\s*$/m)

  process.stdout.write('bundle install acceptance: ok (npm tarball, isolated DSH_HOME add/dump/import/client/web startup/remove)\n')
} finally {
  await rm(dshHome, { force: true, recursive: true })
}
