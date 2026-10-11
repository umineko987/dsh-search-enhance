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

Independent `web_search` and `web_extract` calls within one model step may overlap up to DSH's concurrency limit. Source record writes use a serial queue, keeping each call identity and source reference separate.

`web_search` accepts only `query` and uses one fixed, query-adaptive prompt. Search Profile and depth selectors are no longer exposed. Output limits are fixed at 6,000 answer characters, 8 initially visible sources, and 12 KiB of model-visible text; source collection and retained-source pagination remain independent. Tool loading mode, documentation result count, and tool timeout remain configurable.

## Main and research tool roles

The main Agent and ordinary subagents have `web_search` (only where the host allows it), `docs_search`, `web_extract`, and `web_research`. These definitions are Agent-local, not globally exposed. Quick lookups, library documentation, and known URLs can use the direct tools; multi-step investigations use `web_research` with a self-contained question and constraints.

The dedicated research Agent starts with `web_search`, `docs_search`, `web_extract`, `search_sources`, `web_map`, and the plugin's `structured_output` report tool. It has no `web_research`, general subagent creation, shell, file editing, or unrelated host tools. Host-created subagents use the ordinary Agent role; origin labels and inherited text cannot grant the research role.

The research persona treats every `web_search` as a costly discovery call. It asks for one focused initial query, then prioritizes retained-source pagination and original-page extraction. A follow-up search requires a material, unresolved evidence gap that known sources cannot fill; cosmetic keyword changes, overlapping searches, and asking Grok to re-summarize existing material are discouraged. Sufficient evidence ends retrieval early. This is prompt guidance, not a runtime search-count limit.

In default `toolDiscovery.mode: progressive`, a successful structured source-producing call with a readable retained record enables `search_sources` only after `step/end`, for the next model step. Failed calls, empty sources, missing or unauthorized refs, and prose do not enable it. In `all` mode, only source pagination is preloaded for main/ordinary Agents; it never grants `web_map`. Research tools are fixed regardless of this setting.

Native Mode receives actual tool schemas; Code Mode receives the same callable SDK definitions through `run_code`. DSH handles validation, policy guards, presentation, and execution under the real tool names. The host controls whether ordinary Agents have `web_search`. Replay and HMR use paired standard Native/PTC events plus complete private-store call identity and source authorization; they never parse result prose or create custom SessionEvents.

## Research lifecycle and report

`web_research({ query, timeout_ms? })` uses the official `dsh-subagent-dsh-sdk` backend with an exclusive temporary home and profile. The child receives the parent's explicit official DeepSeek route and model options, but no parent conversation or tool history. The profile registers five research tools and a report submission tool before the first model request. It contains no shell, filesystem, delegation or host credential-store plugins.

The temporary profile loads the official `@deepseek-ai/dsh-llm-retry` plugin. Research overrides the inherited retry policy with a fixed `normal` policy: `maxRetries: 2`, `retryableCodes: ["MALFORMED_RESPONSE"]`. This allows at most three generation attempts for a failed model request, including malformed tool-input JSON, while retaining earlier tool results; it does not restart research or replay completed tool calls. Other failure codes are not made retryable by this policy. Cancellation and the original hard deadline still apply. Failed generation attempts do not become successful tool calls or model-context messages, and no JSON repair is performed; report schema/evidence validation remains mandatory.

The main Agent may pass optional `timeout_ms` for each call, in integer milliseconds from 60000 to 3600000 (1–60 minutes), default 600000 (10 minutes), independently of `toolTimeoutMs`. For example, `web_research({ query: "Compare three approaches using primary sources; report conflicts and unresolved claims.", timeout_ms: 1200000 })` selects 20 minutes for that call. Choose by task complexity; more time does not guarantee stronger evidence. Counting starts before child creation and includes reasoning, retrieval and reporting. Each call's budget is fixed. The finish-only window is `min(timeout_ms × 20%, 120000)`: the default soft cutoff is 480000 ms (minute 8), with hard cancellation at 600000 ms (minute 10).

At the soft cutoff, the child injects a plugin-attributed notice through the official Agent inbox/pre-step API. Its execution guard refuses new retrieval calls, including calls generated before cutoff but dispatched afterwards. The child runs in Native mode and keeps `structured_output` available for reporting. Already-started IO can finish and contribute evidence. The parent may call `web_research` through either Native or Code mode.

The notice becomes model-visible at the next admitted step; it cannot rewrite an in-flight request or guarantee recovery from repeated retries. Stalling until the hard deadline without a valid submission fails. The host execution layer's own timeout applies independently and may cancel the call earlier.

Only a validated, officially accepted structured report can succeed. Finish-only reports use `stop_reason: budget_exhausted` and nonempty limitations describing unfinished/unverified work or unavailable evidence; earlier reports use `completed` or `evidence_limited`. Empty conclusions are valid only with an explanation of unavailable evidence. An already accepted valid report survives a hard-budget race during SDK turn teardown. Caller cancellation and plugin unload always take precedence over success. Hard cancellation requests shutdown through the official SDK and drains started work; noncooperative IO can delay settlement and cleanup beyond the deadline. Missing, invalid, interrupted or unstructured output is never fabricated into a successful report.

Reports contain conclusions with URLs, excerpts, `reading` (`full_text` or `summary_only`), limitations, and a stop reason. The prompt asks for focused conclusions, short relevant excerpts, and strict JSON escaping, including quotes and backslashes in code snippets; Markdown backticks do not escape JSON. The plugin imposes no character, item-count or total-byte ceilings on reports; structure and evidence fields remain validated. Reports distinguish summary-only evidence from full-text evidence and should state unresolved evidence limitations. Report labels are model declarations, not independently verified page-reading proofs. Child `source_ref` values are not transferred to the parent; returned URLs and excerpts are the reusable evidence. Re-search or extract those URLs when more verification is needed.

The bundle mounts the official subagent service when the same entry group has no active standard host service. Each research invocation owns its SDK backend, loopback report channel and temporary profile, and disposes them on completion, cancellation or unload. Runtime packages are pinned to DSH `0.2.0-rc.2`. Only publicly configured `deepseek-official` and `deepseek-account` routes are supported; unavailable authentication or unsupported routes fail before subprocess startup. Custom compositions that supply their own service should disable the `search-enhance-subagents` fallback row.

The temporary profile links this package's exported `research-child` entry; it does not copy or edit user profiles. Model authentication and configured search credentials cross a per-call authenticated loopback channel in memory, rather than being written into profile files or forwarded through host LLM middleware. The channel carries formally accepted reports and separately batches committed child SessionEvents because the SDK backend does not expose its client event stream. The final report remains the parent tool result; display history is not added to the parent model context.

## Read-only research history

The child captures its sole research session through public `session/created` and `session/event` hooks and writes a standard `subagent/descriptor` before its first admitted step. It sends complete committed lifecycle events, not assistant token streams. Each invocation has an authenticated channel and a host-generated research ID bound to its parent; the remote session ID and creation time become fixed at first observation. Serial batches preserve source sequence numbers, payloads, `surfaceOp`, and `sourceEventSeqs`. Exact retries are deduplicated; conflicting retries or gaps close observation explicitly. Step-boundary backpressure and bounded transport attempts avoid accumulating the whole investigation in the observation queue.

When host `sessions` and `sessionProjections` services exist, the plugin creates only a display Session, never a host research Agent. It inherits the parent's stable working directory and delegation depth, records `origin: subagent`, `parentSession`, and `isSeeded: false`, and uses `mode: one-shot`. The host opens its persistence writer before publishing events, flushes the initial descriptor, and only then appends the standard parent `subagent/catalog`. Native `listChildren`, `follow`, and `page` expose this record through `{ kind: "subagent", parentSessionId, childSessionId, mode: "one-shot" }`; DSH Web uses its existing navigation and read-only composer. Wrong-parent and ordinary-session access cannot activate the mirror, and continuation is refused. Public `Session.append` assigns host receipt timestamps; original ordering and references remain unchanged.

On completion, cancellation, unload, or process failure, the official SDK stops and reaps the child before the host closes observation. Committed observations and termination notifications may drain after cancellation, but new credentials, model authentication, and caller-cancelled reports are refused. The host drains its serialized queue, uses official `interruptedTurnClosers` for an unclosed prefix (unknown tool outcomes and an interrupted turn, never invented success), flushes and closes its writer, then detaches the persisted live mirror before removing the channel and temporary profile. Host-persisted catalog and history remain readable through cold queries after restart.

Display services are optional: missing storage/projection services skip the mirror without preventing research; without session persistence, history lasts only until the owning plugin is disposed. No Web UI is installed by this feature. Observation failure retains any readable prefix but does not qualify or replace a successful report. The display does not authorize child `source_ref` pagination in the parent. This integration provides committed-event updates, not token streaming, a native running status light, resumable research, or a separate chat UI.

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
