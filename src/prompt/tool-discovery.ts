import type { Context } from '@deepseek-ai/cordis'


export const TOOL_DISCOVERY_GUIDANCE = [
  'For docs_search, use known library identity for library-specific queries; omit it for broad/cross-project or unknown-library discovery (auto uses Exa). Never guess a Context7 library.',
  'Read webpage bodies with web_extract, choosing exactly one enabled Provider; use host web_fetch (if available) for structured responses such as raw JSON APIs or XML/Atom.',
  'Prefer HTTPS. A title/app shell alone is not usable page-body evidence; choose another suitable enabled extraction Provider instead of refetching the same shell. Never bypass URL safety checks.',
  'For multi-step investigations, comparisons or corroboration across sources, delegate to web_research with a self-contained question and all constraints; wait for its URL-and-excerpt report. Use web_search/docs_search/web_extract directly for quick lookups, documentation or a known URL.',
  'web_research accepts optional timeout_ms for this call\'s total budget, including creation, reasoning, retrieval and reporting: default 600000 ms; integer range 60000–3600000 ms. Choose by task complexity, for example 120000 for a focused comparison or 1200000 for broad corroboration; omission uses the default, and more time does not guarantee better evidence.',
  'After a successful search returns a readable source_ref, search_sources becomes available automatically on the next step. Call it directly to paginate retained sources; no loader is needed.',
].join('\n')

export const EVIDENCE_DISCIPLINE_GUIDANCE = [
  'For current/external facts, use web_research for multi-step investigations; otherwise start with one focused web_search (docs_search for SDK/API docs); do not inspect local files/settings/sessions/credentials unless the user explicitly asks about local state.',
  'Search answers/snippets, source metadata and mapped URLs are discovery, not claim-level evidence.',
  'Before decisive factual/causal conclusions, inspect authoritative URLs with web_extract; label unestablished mechanisms as inference or unconfirmed, never source-stated fact.',
].join('\n')

/** Register main/ordinary-agent guidance; the dedicated research persona owns its own routing. */
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
