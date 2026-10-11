import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const RESEARCH_PROFILE = 'search-enhance-research'

/** An exclusive, disposable home: never read or mutate the user's Harness home. */
export async function prepareResearchProfile() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-search-enhance-research-'))
  try {
    await chmod(home, 0o700)
    const dir = join(home, 'profiles', RESEARCH_PROFILE)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const packageRoot = fileURLToPath(new URL('../../', import.meta.url))
    await mkdir(join(dir, 'node_modules'), { mode: 0o700 })
    await symlink(packageRoot, join(dir, 'node_modules', 'dsh-search-enhance'), 'junction')
    const rows = [
      { id: 'sdk-startup', name: '@deepseek-ai/dsh-sdk-app', config: { profile: RESEARCH_PROFILE } },
      { id: 'session-projection', name: '@deepseek-ai/dsh-session-projection' },
      { id: 'session', name: '@deepseek-ai/dsh-session' },
      { id: 'agents', name: '@deepseek-ai/dsh-agent' },
      { id: 'llm', name: '@deepseek-ai/dsh-llm' },
      { id: 'llm-retry', name: '@deepseek-ai/dsh-llm-retry' },
      { id: 'prompt', name: '@deepseek-ai/dsh-system-prompt', config: { includeHarnessIdentity: false, includeRuntimeContext: false } },
      { id: 'tools', name: '@deepseek-ai/dsh-tools', config: { mode: 'native' } },
      { id: 'storage', name: '@deepseek-ai/dsh-storage' },
      { id: 'storage-json', name: '@deepseek-ai/dsh-storage-json', config: { root: join(home, 'storage') } },
      { id: 'storage-domain', name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } },
      { id: 'research', name: 'dsh-search-enhance/research-child' },
      { id: 'loop', name: '@deepseek-ai/dsh-agent-loop', config: { agents: [] } },
      { id: 'sdk-server', name: '@deepseek-ai/dsh-sdk-jsonrpc-server', inject: ['sdkAppStartup', 'loader'], config: { maxTokensAsSuccess: false } },
    ]
    // JSON is valid YAML. Files contain composition only, never credentials/query.
    for (const [name, value] of Object.entries({
      'package.json': { name: 'search-enhance-internal-research', private: true, dependencies: { 'dsh-search-enhance': `file:${packageRoot}` }, dsh: { profile: { bundles: [] } } },
      'cordis.patch.yml': [{ insert: rows }],
    })) {
      const path = join(dir, name)
      await writeFile(`${path}.new`, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
      await rename(`${path}.new`, path)
    }
    return { home, profile: RESEARCH_PROFILE, dispose: () => rm(home, { recursive: true, force: true }) }
  } catch (error) {
    await rm(home, { recursive: true, force: true })
    throw error
  }
}
