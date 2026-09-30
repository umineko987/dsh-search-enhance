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
  │                       ├─ selected Exa / Tavily / Firecrawl in parallel
  │                       └─ answer + normalized sources + optional source_ref
  │
  ├─ docs_search ─────> Context7 with an explicit library identity
  │                       └─ Exa for broad or unknown-library discovery
  │                          └─ snippets + sources + optional source_ref
  │
  ├─ web_extract ─────> one explicit user-enabled Provider
  │                       └─ page body + route metadata, or error (no fallback)
  │
  ├─ search_tools ────> load optional real tools for the next step
  │
  ├─ search_sources ──> complete source pagination (when loaded)
  │
  └─ web_map ─────────> bounded site URL discovery (when loaded)
```

The plugin keeps discovery, retention, and verification separate:

1. **Discovery:** `web_search` and `docs_search` find answers, snippets, and candidate URLs. This material is discovery metadata, not proof that a page contains a claim.
2. **Retention:** complete bounded source records can be stored under a `source_ref`, independent of how many links fit in the first tool result.
3. **Verification:** `web_extract` retrieves selected pages. The Agent can then distinguish “a Provider found this” from “the fetched page states this.”

Prefer `web_extract` for webpage bodies such as articles, blogs, repository READMEs, and model cards. Prefer the host's `web_fetch`, when available, for raw JSON APIs and structured responses such as arXiv XML/Atom. Use HTTPS directly when available. HTTP 200 with only a title or an app shell is not usable page-body evidence: explicitly choose a suitable enabled extraction Provider instead of repeatedly fetching the same shell. Do not bypass URL safety checks.

Independent `web_search` and `web_extract` calls within one model step may overlap up to DSH's concurrency limit. Source record writes still use the existing serial queue, keeping each call identity and source reference separate.

## Resident tools and on-demand loading

Four tools are resident; two optional tools are registered in the current Agent scope only when requested:

| Tool | Role |
| --- | --- |
| `web_search` | Run the main Grok-compatible search and merge user-selected supplementary sources. |
| `docs_search` | Query Context7 with an explicit library identity, or use Exa for broader discovery. |
| `web_extract` | Retrieve one selected page with a required, user-enabled `provider`. |
| `search_tools` | Load `search_sources` and/or `web_map` for direct calls on the next step. |

`web_search` is installed through the Agent integration so existing DSH Presets and tool guards remain authoritative. The plugin does not add a second general-search tool or re-enable search where the Agent has disabled it.

Native Tool Mode receives real tool schemas; Code Mode receives corresponding SDK entries. DSH owns argument validation, execution, presentation, and policy guards using the actual tool names. `tools.restrict` filters inherited tools, not a scope's own registrations; use the host's monotonic `tools.guard` to deny an Agent-local optional tool.

## Optional capabilities

`search_tools` accepts only these two capability groups:

| Capability | Real tool | Purpose |
| --- | --- | --- |
| `sources` | `search_sources` | Page through a retained source record. |
| `site_map` | `web_map` | Discover bounded candidate URLs below a known site. |

Loading follows these rules:

1. In the default `progressive` mode, a successful loading request registers tools after `step/end`; they become callable on the next model step.
2. In `all` mode, both optional tools are registered when the Agent attaches.
3. Call loaded tools directly. There is no manifest registry or execution gateway; loading results contain only group and tool names.
4. A `source_ref` does not auto-load pagination. Use `search_tools({ capabilities: ["sources"] })` only if additional sources are needed.
5. Completed successful Native calls and Code dispatch events restore loading after session recovery or plugin reload; interrupted or failed requests do not.
6. Context7 resolution remains internal to `docs_search`. Research planning belongs to the Agent, and diagnostics remain in the configuration page and backend rather than the model tool list.

## End-to-end flow

A typical sourced answer proceeds as follows:

1. The Agent sends a general current-information request to `web_search`, or a documentation request to `docs_search`.
2. `web_search` starts the main Grok-compatible search and every user-selected supplemental Provider in parallel. Exa, Tavily, and Firecrawl each receive the same independent source-count cap; unselected Providers are never requested. No profile or query silently enables another Provider.
3. Search sources are bounded and normalized. The web-search quality pipeline de-duplicates equivalent URLs and can prioritize official, primary, version-matching, and fresher sources.
4. `docs_search` uses a supplied `library_id` directly, resolves a supplied `library_name` through Context7, or uses Exa when no library identity is known and `provider: "auto"` is selected.
5. If a complete source record is retained, the result includes `source_ref`. When pagination is needed, load `sources`, then call `search_sources` directly on the next step.
6. For important claims, the Agent selects authoritative URLs and calls `web_extract` with one explicit `provider` from the enabled list in its tool description. Only that Provider runs; unavailable, unsupported, or failed extraction does not trigger another route.
7. If URL discovery below a known site is needed, load `site_map`, then call `web_map` directly.
8. The Agent writes the final response from the main answer, retained sources, and any page bodies it actually retrieved, preserving source links and the distinction between discovery and fetched evidence.

A `source_ref` points to a source list; it is not page content. Claim-level conclusions should rely on selected pages retrieved with `web_extract` whenever practical.

## Implementation map

- Plugin assembly and lifecycle: [`src/index.ts`](../src/index.ts)
- Main search orchestration: [`src/orchestration/orchestrator.ts`](../src/orchestration/orchestrator.ts)
- Documentation routing: [`src/documentation/service.ts`](../src/documentation/service.ts)
- Source retention and pagination: [`src/source-storage/`](../src/source-storage/)
- Capability mapping: [`src/tool-discovery/capabilities.ts`](../src/tool-discovery/capabilities.ts)
- Explicit extraction routing: [`src/web-extract/orchestrator.ts`](../src/web-extract/orchestrator.ts)
