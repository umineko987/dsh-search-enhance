# Search Enhance for DeepSeek Harness

English | [简体中文](README.zh.md)

`dsh-search-enhance` is a search extension for DeepSeek Harness. It uses a Grok-compatible Search API for primary web answers and can optionally use Context7, Exa, Tavily, Firecrawl, and Parallel for documentation lookup, supplementary discovery, page extraction, and site mapping.

The plugin presents search results, sources, and page content separately. Searches return an answer or documentation snippets with source links; you can ask for more sources when needed. To check important details, ask it to read the original page. Search snippets remain distinct from fetched page content.

> Bring your own endpoints and credentials. The plugin ships no API keys. A Grok-compatible endpoint is required for `web_search`; Context7, Exa, Tavily, Firecrawl, and Parallel are optional.

## Key characteristics

- `web_search` uses the Grok-compatible endpoint for the main answer and runs all user-selected supplemental Providers (Exa, Tavily, Firecrawl, Parallel) in parallel, with an independent per-Provider source limit.
- Sources are normalized, de-duplicated, and reordered using source category, requested version, and publication-time signals before they are shown.
- `web_research` delegates multi-step comparisons and source verification to an isolated research Agent using the parent's Provider and model; it returns conclusions, URLs, excerpts, and limitations, not the child's tool history.
- In DSH Web, open `web_research` from the parent conversation's native subagent entry to inspect committed messages and tool results in a read-only history. With host session persistence, completed, cancelled, or failed research remains readable after restart. Updates are not token-by-token, and no native running indicator or continuation is provided.
- `source_ref` keeps the complete source record in private durable storage, allowing the Agent to paginate beyond the links included in the initial result.
- `docs_search` uses Context7 only with an explicit `library_name` or `library_id`; requests without a library identity use Exa discovery.
- `web_extract` requires one explicit `provider` from the user-enabled set: `tavily_extract`, `firecrawl_scrape`, `parallel_extract`, `smart_direct`, or `direct`. It reports the route, evidence level, and available page metadata; failures never switch Providers.
- Source pagination becomes available automatically after a successful search retains readable sources. Website mapping is available to the research Agent, not the main Agent; no manual tool loader is needed.
- Supplemental search defaults to no Providers selected. Unselected Providers are never requested; missing credentials and failures of selected Providers remain visible as warnings.

For implementation details, see [Search workflow architecture](https://github.com/umineko987/dsh-search-enhance/blob/main/guides/search-workflow.md).

## Quick start

### 1. Install

Supports DSH `0.2.0-rc.2`. DSH dependencies are pinned to this exact release; upgrade the DSH CLI first if you are running an older version.

Install the [published npm bundle](https://www.npmjs.com/package/dsh-search-enhance) into the DSH `web` profile:

```bash
dsh plugin --profile web add dsh-search-enhance@latest
```

The bundle supplies the official subagent service and starts research in a separate SDK subprocess with a temporary profile. Research currently supports explicitly configured `deepseek-official` and `deepseek-account` routes with available authentication; other routes fail without fallback. A working DSH CLI is required.

### 2. Start DSH Web

```bash
dsh web
```

### 3. Configure search

Open:

```text
Settings → Plugins → Plugin configuration → dsh-search-enhance
```

In the settings card:

1. Set the xAI endpoint or an explicit Grok-compatible gateway and its key under **Credentials → Grok search**.
2. Choose the matching `completions` or `responses` protocol and model under **Grok search backend**.
3. Use the **Supplemental search providers** and **Available extraction providers** dropdowns to select multiple services. Each service's endpoint, timeout, and credential reference are grouped in its credential card.

Search uses one fixed default strategy: there are no search Profile, depth, or per-level budget controls. Tool loading mode, documentation result count, and timeouts remain separately configurable.

The default credential reference is `SEARCH_API_KEY`. Credential values are stored through DSH Credentials and are not exposed as model parameters.

Official Grok endpoints automatically enable native search without another protocol or toggle:
- Version paths may be omitted: `https://api.x.ai` / `https://us.api.x.ai` gain `/v1`; `https://openrouter.ai` gains `/api/v1` (or `/api` gains `/v1`). This applies to search and model-list requests, without duplicating complete paths or changing custom gateways.
- **xAI**: `https://api.x.ai/v1` (also `https://us.api.x.ai/v1`), with a model such as `grok-4.6`. Requests use Responses with `web_search` + `x_search`, even when `completions` is selected; saved settings are not rewritten.
- **OpenRouter**: `https://openrouter.ai/api/v1`, with a model such as `x-ai/grok-4.6`. The selected protocol is retained and `plugins: [{ "id": "web", "engine": "native" }]` requests native Web Search without silently falling back to Exa; no `:online` suffix is needed. This plugin API is deprecated but remains the current route; unsupported models or routes may fail. See the [native-search compatibility notes](https://github.com/umineko987/dsh-search-enhance/blob/main/guides/grok-native-search.md) for tested models and the distinction from the newer server tool.
- Native search detection is restricted to official HTTPS hosts and Grok models; custom gateways use the configured protocol. Native adapters map `minimal` to `low` and `max` to `xhigh`; `off` omits the reasoning parameter.
- Structured citations enter the source list. If the API reports no completed search, structured citations, or search usage, the result explicitly warns that native search is unconfirmed; prose links alone are not execution evidence.

Save the settings, then ask a current-information question. DSH automatically reloads this plugin in-process when configuration is saved, so changes take effect without restarting DSH; in-flight plugin requests may be interrupted. A successful run shows a `Search` tool row, an answer, and source links.

## Example requests

Use normal language; the plugin gives the Agent routing guidance.

- “Find the most important React 19 user-visible changes. Prefer official release notes and include source links.”
- “Look up the current FastAPI JWT authentication API and show a minimal example from the official documentation.”
- “Read and summarize `https://example.com/article`, separating what the page states from your inference.”
- “Research these three competing solutions, corroborate the important claims, and return source excerpts and unresolved limitations.”

Ask explicitly when you need more sources or pages from a specific website. Check the plugin settings for service configuration status.

## Providers

Configure only the routes you need.

| Provider | Used for | Default credential reference | Required? |
| --- | --- | --- | --- |
| Grok-compatible Search API | Main `web_search` answer and sources | `SEARCH_API_KEY` | For `web_search` |
| Context7 | Documentation lookup for an explicit library | `CONTEXT7_API_KEY` | No |
| Exa | Broad documentation and supplementary discovery | `EXA_API_KEY` | No |
| Tavily | Supplementary search, page extraction, and site mapping | `TAVILY_API_KEY` | No |
| Firecrawl | Supplementary search and page extraction | `FIRECRAWL_API_KEY` | No |
| Parallel | Supplementary search and Markdown page extraction | `PARALLEL_API_KEY` | No |

In the plugin settings, select any combination of **supplemental search Providers**. Each selected Provider runs alongside the main search, using `supplementalSearch.maxSourcesPerProvider` (default `5`, maximum `100`).

Separately, select the **extraction Providers** available to the Agent. Each `web_extract` call must choose exactly one enabled Provider, for example `{ "url": "https://example.com/", "provider": "direct", "format": "markdown" }`. Disabled, unconfigured, unsupported, or failed Providers do not trigger automatic fallback. Parallel extraction supports Markdown only and is disabled by default; enable it explicitly. Other extraction Providers are enabled by default; disable any you do not want the Agent to use.

For `docs_search`, Context7 requires an explicit `library_name` or `library_id`. Without one, `provider: "auto"` uses Exa instead of guessing a package name from the full question.

## On-demand features

To see more sources from a search, ask: “Show me the other sources from this search.”

To find relevant pages on a website, ask: “Find pages about authentication on this website.” The Agent delegates this to `web_research`; mapping requires Tavily to be configured.

The assistant uses these features when needed. You do not have to call tools manually or switch modes. To verify an important claim, you can then ask it to read the original pages.

`web_research({ query, timeout_ms? })` takes a total budget chosen by the main Agent for each call: integer milliseconds from 60000 to 3600000 (1–60 minutes), default 600000 (10 minutes). For example, `{ "query": "Compare these three solutions using primary sources and report unresolved claims.", "timeout_ms": 1200000 }` gives that call 20 minutes, including creation, reasoning, retrieval, and reporting. Quick facts use direct search. The final 20% of the budget, capped at 2 minutes, is reserved for reporting; by default new retrieval stops at minute 8 and hard cancellation starts at minute 10. Individual tool timeouts remain independent.

Research is instructed to make one focused initial search, then reuse retained sources and read original pages. Follow-up searches must address a specific evidence gap that existing sources cannot resolve. These are prompt constraints, not a hard search-call cap; the time budget is not a search quota.

Malformed tool-call JSON can trigger up to two retries of the failed model generation in the same research session. Earlier successful searches and extractions are not replayed, and retries use the original time budget. Reports remain strictly validated, never automatically repaired; the research prompt asks for concise conclusions, short excerpts, and correct JSON escaping.

A partial report uses `stop_reason: budget_exhausted` and lists unfinished work; earlier reports use `completed` or `evidence_limited`. Already-started requests may finish, but a stalled model, missing/invalid report, hard exhaustion without an accepted report, or cancellation can still fail. Caller cancellation and plugin reload take precedence over success. Hard cancellation cannot force unresponsive IO to finish immediately, so cleanup may extend beyond the deadline. More time does not guarantee stronger evidence.

## Update and uninstall

To update, run the installation command above again. To remove the plugin:

```bash
dsh plugin --profile web remove dsh-search-enhance
```

Restart DSH after updating or removing the bundle.
