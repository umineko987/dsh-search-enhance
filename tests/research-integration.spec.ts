import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config } from '../src/config.js'
import { createResearchBridge } from '../src/research/bridge.js'
import { prepareResearchProfile } from '../src/research/profile.js'
import { resolveResearchModel } from '../src/research/model.js'
import type { ResearchBootstrap } from '../src/research/protocol.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function bridge() {
  const ctx = new Context()
  const resolve = vi.fn(async () => ({ value: 'fixture-search-key' }))
  ctx.provide('credentials', { resolve } as unknown as Context['credentials'])
  const controller = new AbortController()
  const bootstrap: ResearchBootstrap = { config: Config({} as never), model: { provider: 'deepseek-official', connection: {} as never }, timeoutMs: 60000, finishMs: 12000, softDeadline: Date.now() + 48000, hardDeadline: Date.now() + 60000 }
  const auth = vi.fn(async () => ({ 'x-api-key': 'fixture-model-key' }))
  const channel = await createResearchBridge(ctx, bootstrap, auth, controller.signal)
  cleanup.push(async () => { await channel.dispose(); await ctx.fiber.dispose() })
  const request = (path: string, body?: unknown, token = channel.env.DSH_RESEARCH_TOKEN) => fetch(channel.env.DSH_RESEARCH_CHANNEL + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { ctx, channel, bootstrap, request, resolve, auth, controller }
}
describe('isolated research bootstrap and report channel', () => {
  it('allows only configured search credentials and separate model authentication', async () => {
    const h = await bridge()
    expect((await h.request('/bootstrap')).status).toBe(200)
    expect((await h.request('/model-auth')).status).toBe(200)
    expect(h.auth).toHaveBeenCalledOnce()
    const ref = h.bootstrap.config.searchApi.credentialRef
    expect(await (await h.request(`/credential/${encodeURIComponent(ref)}`)).json()).toEqual({ value: 'fixture-search-key' })
    expect(h.resolve).toHaveBeenCalledWith(credentialRef(ref))
    expect((await h.request('/credential/UNRELATED_SECRET')).status).toBe(403)
    expect((await h.request('/bootstrap', undefined, 'wrong-token')).status).toBe(403)
    expect(h.resolve).toHaveBeenCalledOnce()
  })
  it('requires a valid formally delivered report and an independent completion signal', async () => {
    const h = await bridge()
    expect(h.channel.report()).toBeUndefined()
    const report = { conclusions: [], limitations: ['No evidence accessible.'], stop_reason: 'evidence_limited' }
    expect((await h.request('/report', { acceptedAt: Date.now(), report: { ...report, source_ref: 'src_PRIVATE' } })).status).toBe(400)
    expect((await h.request('/report', { acceptedAt: h.bootstrap.hardDeadline + 1, report })).status).toBe(400)
    expect((await h.request('/report', { acceptedAt: Date.now(), report })).status).toBe(200)
    expect(h.channel.report()).toEqual(report)
    expect((await h.request('/finished', {})).status).toBe(200)
    await h.channel.finished
  })
  it('accepts only budget_exhausted reports after the soft deadline', async () => {
    const h = await bridge()
    Object.assign(h.bootstrap, { softDeadline: Date.now() - 1 })
    const report = { conclusions: [], limitations: ['Research unfinished.'], stop_reason: 'evidence_limited' }
    expect((await h.request('/report', { acceptedAt: Date.now(), report })).status).toBe(400)
    expect((await h.request('/report', { acceptedAt: Date.now(), report: { ...report, stop_reason: 'budget_exhausted' } })).status).toBe(200)
  })
  it('refuses credentials and late report delivery after caller cancellation', async () => {
    const h = await bridge()
    h.controller.abort()
    expect((await h.request('/model-auth')).status).toBe(400)
    expect((await h.request('/report', { acceptedAt: Date.now(), report: { conclusions: [], limitations: ['Cancelled.'], stop_reason: 'evidence_limited' } })).status).toBe(400)
    expect(h.auth).not.toHaveBeenCalled()
    expect(h.channel.report()).toBeUndefined()
  })
  it('creates an exclusive private profile without host tools, credentials or recursive delegation', async () => {
    const profile = await prepareResearchProfile()
    cleanup.push(profile.dispose)
    expect((await stat(profile.home)).mode & 0o777).toBe(0o700)
    const path = join(profile.home, 'profiles', profile.profile, 'cordis.patch.yml')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const text = await readFile(path, 'utf8')
    expect(text).not.toMatch(/api-key|credentials-local|fs-sandbox|subagent|bash|web-research-budget/)
    expect(JSON.parse(text)[0].insert.some((row: { id: string }) => row.id === 'research')).toBe(true)
    await profile.dispose()
    await expect(stat(profile.home)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects unsupported model routes before preparing any subprocess', async () => {
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    const parent = { options: { provider: 'mock', model: 'fixture' }, session: { requestHeader: () => undefined } } as Agent
    await expect(resolveResearchModel(ctx, parent)).rejects.toThrow(/only explicitly configured/)
  })
  it.each(['deepseek-official', 'deepseek-account'])('resolves %s using public configuration and explicit authentication only', async provider => {
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    const credentials = vi.fn(async () => ({ value: 'fixture-model-key' }))
    const token = vi.fn(async () => 'fixture-account-token')
    ctx.provide('credentials', { resolve: credentials } as unknown as Context['credentials'])
    ctx.provide('deepseekAccount', { resolveToken: token } as unknown as Context['deepseekAccount'])
    ctx.provide('llm', { listConfigurableProviders: () => [{ provider, settingsNs: 'model-config' }] } as unknown as Context['llm'])
    ctx.provide('configEditor', { configuration: () => [{ entry: { options: { id: 'model-config', name: provider === 'deepseek-account' ? '@deepseek-ai/dsh-llm-deepseek-account' : '@deepseek-ai/dsh-llm-deepseek-api-key' } }, inherited: { baseURL: 'http://127.0.0.1:12345/anthropic', thinking: 'disabled', arbitraryHostExtension: 'PRIVATE_HOST_EXTENSION' }, override: { apiKeyEnv: 'FIXTURE_MODEL_KEY' } }] } as unknown as Context['configEditor'])
    const parent = { options: { provider, model: 'fixture-model', reasoningEffort: 'off' }, session: { requestHeader: () => undefined } } as unknown as Agent
    const model = await resolveResearchModel(ctx, parent)
    expect(model.route).toMatchObject({ provider, model: 'fixture-model', reasoningEffort: 'off' })
    expect(model.connection.baseURL).toBe('http://127.0.0.1:12345/anthropic')
    expect(JSON.stringify(model.connection)).not.toMatch(/PRIVATE_HOST_EXTENSION|fixture-model-key|fixture-account-token/)
    expect(await model.auth()).toEqual(provider === 'deepseek-account' ? { 'x-dsh-auth-token': 'fixture-account-token' } : { 'x-api-key': 'fixture-model-key' })
    if (provider === 'deepseek-account') {
      expect(credentials).not.toHaveBeenCalled()
      expect(token).toHaveBeenCalledWith(model.connection.baseURL)
      token.mockResolvedValue(undefined as never)
    } else {
      expect(token).not.toHaveBeenCalled()
      expect(credentials).toHaveBeenCalledWith(credentialRef('FIXTURE_MODEL_KEY'))
      credentials.mockResolvedValue(undefined as never)
    }
    await expect(model.auth()).rejects.toThrow(/authentication is unavailable/)
  })
})
