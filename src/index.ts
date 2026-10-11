import type { Context } from '@deepseek-ai/cordis'
import { type Config as SearchEnhanceConfigValue, Config as SearchEnhanceConfig } from './config.js'
import { ResearchExecutor } from './research/executor.js'
import { registerToolDiscoveryGuidance } from './prompt/tool-discovery.js'
import { installAgentToolDisclosure } from './tool-discovery/index.js'
import { createWebResearchTool } from './tools/index.js'
import { createSearchServices } from './tools/services.js'
import { installWebConfigBridge } from './web-config/host.js'

export const name = 'search-enhance'
// Display services are discovered per call through reflect.get, never required here.
export const inject = ['agents', 'configEditor', 'credentials', 'llm', 'storageDomain', 'subagents', 'systemPrompt', 'tools']
export const Config = SearchEnhanceConfig

export async function apply(ctx: Context, config: SearchEnhanceConfigValue): Promise<void> {
  const { tools, operations } = await createSearchServices(ctx, config)
  const research = new ResearchExecutor(ctx, () => config)
  ctx.effect(() => async () => { await operations.stop(); research.dispose() })
  installAgentToolDisclosure(ctx, {
    mode: config.toolDiscovery.mode,
    residentTools: {
      docs_search: tools.docs_search,
      web_extract: tools.web_extract,
      web_research: createWebResearchTool({ research, operations }),
    },
    canReadSourceRef: (agent, ref) => ctx.searchEnhanceSources.lookup(agent.session, ref).state === 'found',
    sourceRefForCall: (agent, call) => ctx.searchEnhanceSources.sourceRefForCall(agent.session, call),
    webSearchDefinition: tools.web_search,
    deferredTools: { sources: tools.search_sources, site_map: tools.web_map },
  })
  registerToolDiscoveryGuidance(ctx)
  installWebConfigBridge(ctx)
}
