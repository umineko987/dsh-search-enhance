import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const dshVersion = '0.1.7-rc.2'
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const lockfile = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))

describe('DSH release compatibility', () => {
  it('pins every declared DSH dependency to the supported release', () => {
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const entries = Object.entries(manifest[section]).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
      expect(entries.length).toBeGreaterThan(0)
      for (const [name, version] of entries) {
        expect(version, `${section}.${name}`).toBe(dshVersion)
      }
    }
  })

  it('locks the entire DSH test runtime to the supported release', () => {
    const entries = Object.entries(lockfile.packages).filter(([path]) => path.includes('/@deepseek-ai/dsh-'))
    expect(entries.length).toBeGreaterThan(0)
    for (const [path, pkg] of entries) {
      expect((pkg as { version: string }).version, path).toBe(dshVersion)
    }
  })
})
