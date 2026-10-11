import type { Context } from '@deepseek-ai/cordis'

import { type Config as SearchEnhanceConfigValue } from '../config.js'
import {
  Context7CachedOperations,
  DocumentationSearchService,
  PersistentContext7Cache,
} from '../documentation/index.js'
import { SearchOrchestrator } from '../orchestration/index.js'
import { Context7RemoteClient } from '../providers/context7.js'
import { ExaProvider } from '../providers/exa.js'
import { FirecrawlSearchProvider } from '../providers/firecrawl.js'
import { FirecrawlScrapeProvider } from '../providers/firecrawl-scrape.js'
import { DirectFetchProvider } from '../providers/direct-fetch.js'
import { ParallelSearchProvider } from '../providers/parallel.js'
import { ParallelExtractProvider } from '../providers/parallel-extract.js'
import { SearchApiProvider } from '../providers/search-api.js'
import { SmartDirectProvider } from '../providers/smart-direct.js'
import { TavilySearchProvider } from '../providers/tavily.js'
import { TavilyExtractProvider } from '../providers/tavily-extract.js'
import { TavilyMapProvider } from '../providers/tavily-map.js'
import {
  SOURCE_RECORD_DOMAIN_SPEC,
  SOURCE_RECORD_TABLE_NAME,
  SearchEnhanceSourceService,
  SourceRecordStore,
} from '../source-storage/index.js'
import {
  ForegroundOperationScope,
  createDocsSearchTool,
  createSearchSourcesTool,
  createWebExtractTool,
  createWebMapTool,
  createWebSearchTool,
} from '../tools/index.js'
import { WebExtractOrchestrator } from '../web-extract/orchestrator.js'


/** Shared search services only; no host disclosure, UI or research delegation. */
export async function createSearchServices(ctx: Context, effective: SearchEnhanceConfigValue) {
  const domain = await ctx.storageDomain.open(SOURCE_RECORD_DOMAIN_SPEC)
  const store = new SourceRecordStore(domain.table(SOURCE_RECORD_TABLE_NAME), {
    maxBytes: effective.retention.sourceEventMaxBytes,
    maxRecords: effective.retention.sourceStoreMaxRecords,
    maxSources: effective.retention.sourceEventMaxSources,
    maxPageSize: effective.retention.searchSourcesMaxPageSize,
    maxPageBytes: effective.retention.searchSourcesPageMaxBytes,
    maxSnippetCharacters: effective.retention.searchSourcesSnippetMaxCharacters,
  })

  const operations = new ForegroundOperationScope()
  // ConfigEditor reconciles edits by rebuilding this plugin in-process; a saved
  // configuration is active as soon as the edit request completes.
  const getConfig = (): SearchEnhanceConfigValue => effective
  const providerDependencies = { credentials: ctx.credentials }
  const context7Cache = new PersistentContext7Cache(ctx.storageDomain, {
    maxEntries: effective.cache.maxEntries,
    maxEntryBytes: effective.cache.context7EntryMaxBytes,
  })
  const cachedContext7 = new Context7CachedOperations(context7Cache)
  const context7Remote = new Context7RemoteClient(providerDependencies)
  const exa = new ExaProvider(providerDependencies)
  let documentation: DocumentationSearchService | undefined

  // Keep dependent shutdown in one ordered disposer: stop both public-tool and
  // service calls, close the lazy docs cache, then drain source writes/domain.
  ctx.effect(() => async () => {
    await Promise.all([
      operations.stop(),
      documentation?.stop() ?? Promise.resolve(),
    ])
    await context7Cache.close()
    store.stop()
    await store.drain()
    await domain.close()
  })
  new SearchEnhanceSourceService(ctx, store)
  documentation = new DocumentationSearchService(ctx, {
    context7: context7Remote,
    context7Cache: cachedContext7,
    exa,
    getConfig,
  })

  const searchApi = new SearchApiProvider({
    credentials: ctx.credentials,
    getConfig,
  })
  const firecrawl = new FirecrawlSearchProvider(providerDependencies)
  const tavily = new TavilySearchProvider(providerDependencies)
  const parallel = new ParallelSearchProvider(providerDependencies)
  const orchestrator = new SearchOrchestrator({
    exa,
    firecrawl,
    getConfig,
    mainSearch: searchApi,
    parallel,
    tavily,
  })
  const webExtract = new WebExtractOrchestrator({
    tavilyExtract: new TavilyExtractProvider(providerDependencies),
    firecrawlScrape: new FirecrawlScrapeProvider(providerDependencies),
    parallelExtract: new ParallelExtractProvider(providerDependencies),
    smartDirect: new SmartDirectProvider(),
    direct: new DirectFetchProvider(),
    getConfig,
  })
  return {
    operations,
    tools: {
      web_search: createWebSearchTool({ getConfig, operations, orchestrator, sources: ctx.searchEnhanceSources }),
      docs_search: createDocsSearchTool({ documentation, getConfig, operations, sources: ctx.searchEnhanceSources }),
      web_extract: createWebExtractTool({ getConfig, operations, orchestrator: webExtract }),
      search_sources: createSearchSourcesTool({ getConfig, operations, sources: ctx.searchEnhanceSources }),
      web_map: createWebMapTool({ getConfig, operations, provider: new TavilyMapProvider(providerDependencies) }),
    },
  }
}
