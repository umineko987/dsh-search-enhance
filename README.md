# Search Enhance for DeepSeek Harness

English | [简体中文](README.zh.md)

`dsh-search-enhance` is a search extension for DeepSeek Harness. It uses a Grok-compatible Search API for primary web answers and can optionally use Context7, Exa, Tavily, and Firecrawl for documentation lookup, supplementary discovery, page extraction, and site mapping.

The plugin handles search, source retention, and page retrieval as separate steps. `web_search` and `docs_search` return an answer or documentation snippets with visible sources; the complete source record can be stored under a `source_ref` and paged later. Important pages can then be retrieved with `web_extract`, so search snippets remain distinct from fetched page content.

> Bring your own endpoints and credentials. The plugin ships no API keys. A Grok-compatible endpoint is required for `web_search`; Context7, Exa, Tavily, and Firecrawl are optional.

![A DSH Web session that searches, checks documentation, extracts an official page, and returns a sourced answer](https://raw.githubusercontent.com/umineko987/dsh-search-enhance/main/assets/search-workflow.png)

## Key characteristics

- `web_search` uses the Grok-compatible endpoint for the main answer and runs all user-selected supplemental Providers (Exa, Tavily, Firecrawl) in parallel, with an independent per-Provider source limit.
- Sources are normalized, de-duplicated, and reordered using source category, requested version, and publication-time signals before they are shown.
- `source_ref` keeps the complete source record in private durable storage, allowing the Agent to paginate beyond the links included in the initial result.
- `docs_search` uses Context7 only with an explicit `library_name` or `library_id`; requests without a library identity use Exa discovery.
- `web_extract` requires one explicit `provider` from the user-enabled set: `tavily_extract`, `firecrawl_scrape`, `smart_direct`, or `direct`. It reports the route, evidence level, and available page metadata; failures never switch Providers.
- Source pagination, Context7 detail operations, site mapping, research planning, and diagnostics are disclosed on demand through `search_tools` and `search_call`.
- Native Tool Mode and Code Mode use the same fixed tool surface and canonical outputs. DSH Settings, Credentials, Agent Presets, guards, and lifecycle cleanup continue to apply.
- Supplemental search defaults to no Providers selected. Unselected Providers are never requested; missing credentials and failures of selected Providers remain visible as warnings.

For the complete routing, evidence, and progressive-disclosure flow, see [Search workflow architecture](https://github.com/umineko987/dsh-search-enhance/blob/main/guides/search-workflow.md).

## Quick start

### 1. Install

Supports only DSH `0.1.5-rc.2`. DSH dependencies are pinned to this exact release; older versions and other prereleases are not supported.

If migrating from the scoped `@kkkneko/dsh-search-enhance` package, first run `dsh plugin --profile web remove @kkkneko/dsh-search-enhance` to avoid loading both bundles.

Install the [published npm bundle](https://www.npmjs.com/package/dsh-search-enhance) into the DSH `web` profile:

```bash
dsh plugin --profile web add dsh-search-enhance@latest
```

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

The default credential reference is `SEARCH_API_KEY`. Credential values are stored through DSH Credentials and are not exposed as model parameters.

Official Grok endpoints automatically enable native search without another protocol or toggle:
- Version paths may be omitted: `https://api.x.ai` / `https://us.api.x.ai` gain `/v1`; `https://openrouter.ai` gains `/api/v1` (or `/api` gains `/v1`). This applies to search and model-list requests, without duplicating complete paths or changing custom gateways.
- **xAI**: `https://api.x.ai/v1` (also `https://us.api.x.ai/v1`), with a model such as `grok-4.6`. Requests use Responses with `web_search` + `x_search`, even when `completions` is selected; saved settings are not rewritten.
- **OpenRouter**: `https://openrouter.ai/api/v1`, with a model such as `x-ai/grok-4.6`. The selected protocol is retained and `openrouter:web_search` with `engine: native` is sent; no `:online` suffix is needed. Model support and workspace policy still govern OpenRouter's actual engine; to prohibit its fallback, allow only `native` in the workspace.
- Detection is restricted to those official HTTPS hosts and Grok models. Other models and compatible proxies are unchanged. Native adapters map `minimal` to `low` and `max` to `xhigh`; `off` still omits the reasoning parameter.
- Structured citations enter the source list. If the API reports no completed search, structured citations, or search usage, the result explicitly warns that native search is unconfirmed; prose links alone are not execution evidence.

Save the settings, restart DSH, and ask a current-information question. A successful run shows a `Search` tool row, an answer, and source links.

## Example requests

Use normal language; the plugin gives the Agent routing guidance.

- “Find the most important React 19 user-visible changes. Prefer official release notes and include source links.”
- “Look up the current FastAPI JWT authentication API and show a minimal example from the official documentation.”
- “Read and summarize `https://example.com/article`, separating what the page states from your inference.”

Ask explicitly when you need complete source pagination, site discovery, a research plan, or Provider diagnostics.

## Providers

Configure only the routes you need.

| Provider | Used for | Default credential reference | Required? |
| --- | --- | --- | --- |
| Grok-compatible Search API | Main `web_search` answer and sources | `SEARCH_API_KEY` | For `web_search` |
| Context7 | Documentation lookup for an explicit library | `CONTEXT7_API_KEY` | No |
| Exa | Broad documentation and supplementary discovery | `EXA_API_KEY` | No |
| Tavily | Supplementary search, page extraction, and site mapping | `TAVILY_API_KEY` | No |
| Firecrawl | Supplementary search and page extraction | `FIRECRAWL_API_KEY` | No |

In the plugin settings, select any combination of **supplemental search Providers**. Each selected Provider runs alongside the main search, using `supplementalSearch.maxSourcesPerProvider` (default `5`, maximum `100`). This selection applies to all search profiles; there is no implicit Exa enhancement or shared 60/40 budget.

Separately, select the **extraction Providers** available to the Agent. Each `web_extract` call must choose exactly one enabled Provider, for example `{ "url": "https://example.com/", "provider": "direct", "format": "markdown" }`. Disabled, unconfigured, unsupported, or failed Providers do not trigger automatic fallback. Extraction Providers are enabled by default; disable any you do not want the Agent to use.

**Configuration change:** replace the former `extraDiscoverySources` profile budgets with `supplementalSearch` selections. Enable `exa`, `tavily`, and/or `firecrawl` explicitly; existing API credentials alone do not enable supplemental search. Existing extraction `enabled` settings remain the allowlist. Save settings and restart DSH. `fallbackMode` now applies only to the unchanged documentation-search routing.

For `docs_search`, Context7 requires an explicit `library_name` or `library_id`. Without one, `provider: "auto"` uses Exa instead of guessing a package name from the full question.

## Tool disclosure

The model-facing surface remains five tools: `web_search`, `docs_search`, `web_extract`, `search_tools`, and `search_call`. Advanced operations are disclosed through manifests rather than registered as additional model tools.

The default `progressive` mode activates a newly disclosed capability on the next model step. In `all` mode, deferred operations are active immediately. Native Tool Mode and Code Mode use the same schemas, execution policy, and canonical outputs.

When `web_search` or `docs_search` returns a `source_ref`, the plugin automatically activates source pagination and appends its real operation manifest.

## Update and uninstall

To update, run the installation command above again. To remove the plugin:

```bash
dsh plugin --profile web remove dsh-search-enhance
```

Restart DSH after updating or removing the bundle.
