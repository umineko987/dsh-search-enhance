# Search workflow architecture

English | [简体中文](search-workflow.zh.md)

This document describes how Search Enhance routes a request from discovery to source retention and page verification. Installation and configuration stay in the main [README](../README.md).

## Overview

```text
User request
  │
  ▼
DSH Agent
  │
  ├─ web_search ──────> Grok-compatible Search API
  │                       ├─ selected Exa / Tavily / Firecrawl / Parallel in parallel
  │                       └─ answer + normalized sources + optional source_ref
  │
  ├─ docs_search ─────> Context7 with an explicit library identity
  │                       └─ Exa for broad or unknown-library discovery
  │                          └─ snippets + sources + optional source_ref
  │
  ├─ web_extract ─────> one explicit user-enabled Provider
  │                       └─ page body + route metadata, or error (no fallback)
  │
  ├─ search_sources ──> retained-source pagination (automatic next-step disclosure)
  │
  └─ web_research ────> isolated research Agent (same Provider/model)
                          ├─ search / docs / extract / source pagination / site mapping
                          └─ validated report: conclusions + URLs + excerpts + limitations
```

The plugin keeps discovery, retention, and verification separate:

1. **Discovery:** `web_search` and `docs_search` find answers, snippets, and candidate URLs. This material is discovery metadata, not proof that a page contains a claim.
2. **Retention:** complete bounded source records can be stored under a `source_ref`, independent of how many links fit in the first tool result.
3. **Verification:** `web_extract` retrieves selected pages. The Agent can then distinguish “a Provider found this” from “the fetched page states this.”

Prefer `web_extract` for webpage bodies such as articles, blogs, repository READMEs, and model cards. Prefer the host's `web_fetch`, when available, for raw JSON APIs and structured responses such as arXiv XML/Atom. Use HTTPS directly when available. HTTP 200 with only a title or an app shell is not usable page-body evidence: explicitly choose a suitable enabled extraction Provider instead of repeatedly fetching the same shell. Do not bypass URL safety checks.


## End-to-end flow

A typical sourced answer proceeds as follows:

1. The Agent sends a general current-information request to `web_search`, or a documentation request to `docs_search`.
2. `web_search` starts the main Grok-compatible search and every user-selected supplemental Provider in parallel. Exa, Tavily, Firecrawl, and Parallel each receive the same independent source-count cap; unselected Providers are never requested. The query never silently enables another Provider.
3. Search sources are bounded and normalized. The web-search quality pipeline de-duplicates equivalent URLs and can prioritize official, primary, version-matching, and fresher sources.
4. `docs_search` uses a supplied `library_id` directly, resolves a supplied `library_name` through Context7, or uses Exa when no library identity is known and `provider: "auto"` is selected.
5. If a complete source record is retained, the result includes `source_ref`. `search_sources` becomes available automatically on the next step for direct pagination.
6. For important claims, the Agent selects authoritative URLs and calls `web_extract` with one explicit `provider` from the enabled list in its tool description. Only that Provider runs; unavailable, unsupported, or failed extraction does not trigger another route.
7. If URL discovery below a known site is needed, delegate with `web_research`; only its research Agent can call `web_map`.
8. The Agent writes the final response from the main answer, retained sources, and any page bodies it actually retrieved, preserving source links and the distinction between discovery and fetched evidence.

A `source_ref` points to a source list; it is not page content. Claim-level conclusions should rely on selected pages retrieved with `web_extract` whenever practical.

## Implementation map

- Plugin assembly and lifecycle: [`src/index.ts`](../src/index.ts)
- Main search orchestration: [`src/orchestration/orchestrator.ts`](../src/orchestration/orchestrator.ts)
- Documentation routing: [`src/documentation/service.ts`](../src/documentation/service.ts)
- Source retention and pagination: [`src/source-storage/`](../src/source-storage/)
- Capability mapping: [`src/tool-discovery/capabilities.ts`](../src/tool-discovery/capabilities.ts)
- Explicit extraction routing: [`src/web-extract/orchestrator.ts`](../src/web-extract/orchestrator.ts)
- Dedicated research lifecycle and report: [`src/research/`](../src/research/)
