import type { Context } from '@deepseek-ai/cordis'

export const TOOL_DISCOVERY_GUIDANCE = [
  'Search Enhance keeps web_search, docs_search, web_extract, and search_tools resident. Optional real tools search_sources and web_map can be loaded per Agent.',
  'For docs_search, pass library_id when an exact /org/project id is known, or library_name when the package/product is known; for example docs_search({ query: "JWT authentication middleware API", library_name: "FastAPI" }). Library resolution is handled internally.',
  'For broad, cross-project, or unknown-library documentation discovery, use docs_search with provider: "auto" and no library identity; this uses Exa instead of guessing a Context7 library.',
  'For webpage bodies (articles, blogs, repository READMEs, and model cards), prefer web_extract with exactly one explicitly selected enabled Provider. Use the host web_fetch, when available, for raw JSON APIs, XML/Atom feeds, or other structured responses.',
  'Use HTTPS URLs directly when available. HTTP 200 with only a title or an app shell is not usable page-body evidence; choose a suitable enabled extraction Provider explicitly rather than repeatedly fetching the same shell. Do not bypass URL safety checks.',
  'Use search_tools({ capabilities: ["sources"] }) only when a source_ref needs pagination, or search_tools({ capabilities: ["site_map"] }) to discover URLs under a known website. Do not load optional tools preemptively.',
  'Newly loaded tools become available on the next model step. Call search_sources or web_map directly using the tool definitions supplied by the host; already loaded tools stay available.',
  'Search source metadata and mapped URLs are discovery, not verified webpage-body evidence.',
].join('\n')

export const EVIDENCE_DISCIPLINE_GUIDANCE = [
  'For current or external factual questions, start with one focused web_search (use docs_search for SDK/API documentation); do not inspect local files, settings, sessions, or credentials unless the user explicitly asks about local state.',
  'Treat web_search/docs_search answers, snippets, and source metadata as discovery, not claim-level evidence.',
  'Before asserting decisive factual or causal conclusions, inspect selected authoritative URLs with web_extract; never present an inferred mechanism as source-stated fact, and label unestablished mechanisms as inference or unconfirmed.',
].join('\n')

/** Register deterministic guidance that never reads Agent state or tool visibility. */
export function registerToolDiscoveryGuidance(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'search-enhance:tool-discovery',
    order: 121,
    text: TOOL_DISCOVERY_GUIDANCE,
  })
  ctx.systemPrompt.section({
    name: 'search-enhance:evidence-discipline',
    order: 122,
    text: EVIDENCE_DISCIPLINE_GUIDANCE,
  })
}
