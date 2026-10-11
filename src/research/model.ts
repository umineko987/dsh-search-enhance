import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import '@deepseek-ai/dsh-deepseek-account'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { deepSeekConfigFields, resolveAdapterOptions, type DeepSeekConnectionOptions, type Options } from '@deepseek-ai/dsh-llm-deepseek'
import { assertUsableApiKey } from '@deepseek-ai/dsh-llm'
import { parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent'

/** Only official DeepSeek protocol routes have a verified public authentication seam. */
export async function resolveResearchModel(ctx: Context, parent: Agent) {
  const route = parentAgentOptionsForDelegation(parent)
  if (route.model === undefined || !['deepseek-official', 'deepseek-account'].includes(route.provider ?? '')) {
    throw new Error('web_research isolated SDK supports only explicitly configured deepseek-official or deepseek-account routes; no fallback is available')
  }
  const provider = route.provider!
  const pluginName = provider === 'deepseek-account' ? '@deepseek-ai/dsh-llm-deepseek-account' : '@deepseek-ai/dsh-llm-deepseek-api-key'
  const directory = ctx.llm.listConfigurableProviders().find(row => row.provider === provider)
  const row = ctx.configEditor.configuration().find(({ entry }) => entry.options.id === directory?.settingsNs && entry.options.name === pluginName)
  if (row === undefined) throw new Error('web_research requires a publicly addressable official DeepSeek provider configuration')
  const raw = { ...row.inherited, ...row.override }
  const options: Record<string, unknown> = {}
  for (const key of Object.keys(deepSeekConfigFields)) if (raw[key] !== undefined) options[key] = raw[key]
  const connection = resolveAdapterOptions(options as Options, launchEnvironmentOf(ctx))
  const auth = provider === 'deepseek-account'
    ? async () => {
      const token = await ctx.get('deepseekAccount')?.resolveToken(connection.baseURL)
      if (token === undefined) throw new Error('web_research account authentication is unavailable for the configured inference origin; sign-in/authorization is required')
      return { 'x-dsh-auth-token': token }
    }
    : async () => {
      const ref = credentialRef(typeof raw.apiKeyEnv === 'string' ? raw.apiKeyEnv : 'DEEPSEEK_API_KEY')
      const value = await ctx.credentials.resolve(ref)
      if (value === undefined) throw new Error('web_research DeepSeek API-key authentication is unavailable')
      return { 'x-api-key': assertUsableApiKey(value.value, 'web_research', ref) }
    }
  // Fail before creating a process, not by silently trying SDK defaults.
  await auth()
  return { route, connection, auth }
}

export interface ResearchModelConfig {
  readonly provider: string
  readonly connection: DeepSeekConnectionOptions
}
