import type { Context } from '@deepseek-ai/cordis'

export const TOOL_DISCOVERY_GUIDANCE = [
  'For docs_search, use known library identity for library-specific queries; omit it for broad/cross-project or unknown-library discovery (auto uses Exa). Never guess a Context7 library.',
  'Read webpage bodies with web_extract, choosing exactly one enabled Provider; use host web_fetch (if available) for structured responses such as raw JSON APIs or XML/Atom.',
  'Prefer HTTPS. A title/app shell alone is not usable page-body evidence; choose another suitable enabled extraction Provider instead of refetching the same shell. Never bypass URL safety checks.',
  'Load sources via search_tools for source_ref pagination, or site_map for URLs under a known site. Call newly loaded search_sources/web_map directly on the next model step; reuse loaded tools and do not load preemptively.',
].join('\n')

export const EVIDENCE_DISCIPLINE_GUIDANCE = [
  'For current/external facts, start with one focused web_search (docs_search for SDK/API docs); do not inspect local files/settings/sessions/credentials unless the user explicitly asks about local state.',
  'Search answers/snippets, source metadata and mapped URLs are discovery, not claim-level evidence.',
  'Before decisive factual/causal conclusions, inspect authoritative URLs with web_extract; label unestablished mechanisms as inference or unconfirmed, never source-stated fact.',
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
