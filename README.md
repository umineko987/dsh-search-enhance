# Search Enhance for DeepSeek Harness

English | [简体中文](README.zh.md)

`dsh-search-enhance` is a search extension for DeepSeek Harness. It uses a Grok-compatible Search API for primary web answers and can optionally use Context7, Exa, Tavily, and Firecrawl for documentation lookup, supplementary discovery, page extraction, and site mapping.

The plugin presents search results, sources, and page content separately. Searches return an answer or documentation snippets with source links; you can ask for more sources when needed. To check important details, ask it to read the original page. Search snippets remain distinct from fetched page content.

> Bring your own endpoints and credentials. The plugin ships no API keys. A Grok-compatible endpoint is required for `web_search`; Context7, Exa, Tavily, and Firecrawl are optional.

## Key characteristics

- `web_search` uses the Grok-compatible endpoint for the main answer and runs all user-selected supplemental Providers (Exa, Tavily, Firecrawl) in parallel, with an independent per-Provider source limit.
- Sources are normalized, de-duplicated, and reordered using source category, requested version, and publication-time signals before they are shown.
- `source_ref` keeps the complete source record in private durable storage, allowing the Agent to paginate beyond the links included in the initial result.
- `docs_search` uses Context7 only with an explicit `library_name` or `library_id`; requests without a library identity use Exa discovery.
- `web_extract` requires one explicit `provider` from the user-enabled set: `tavily_extract`, `firecrawl_scrape`, `smart_direct`, or `direct`. It reports the route, evidence level, and available page metadata; failures never switch Providers.
- Ask for more sources or related pages on a specific website when needed; no manual tool loading is required.
- Supplemental search defaults to no Providers selected. Unselected Providers are never requested; missing credentials and failures of selected Providers remain visible as warnings.

For implementation details, see [Search workflow architecture](https://github.com/umineko987/dsh-search-enhance/blob/main/guides/search-workflow.md).

## Quick start

### 1. Install

Supports DSH `0.2.0-rc.2`. DSH dependencies are pinned to this exact release; upgrade the DSH CLI first if you are running an older version.

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
- Native search detection is restricted to official HTTPS hosts and Grok models; custom gateways use the configured protocol. Native adapters map `minimal` to `low` and `max` to `xhigh`; `off` omits the reasoning parameter.
- Structured citations enter the source list. If the API reports no completed search, structured citations, or search usage, the result explicitly warns that native search is unconfirmed; prose links alone are not execution evidence.

Save the settings, then ask a current-information question. DSH automatically reloads this plugin in-process when configuration is saved, so changes take effect without restarting DSH; in-flight plugin requests may be interrupted. A successful run shows a `Search` tool row, an answer, and source links.

## Example requests

Use normal language; the plugin gives the Agent routing guidance.

- “Find the most important React 19 user-visible changes. Prefer official release notes and include source links.”
- “Look up the current FastAPI JWT authentication API and show a minimal example from the official documentation.”
- “Read and summarize `https://example.com/article`, separating what the page states from your inference.”

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

In the plugin settings, select any combination of **supplemental search Providers**. Each selected Provider runs alongside the main search, using `supplementalSearch.maxSourcesPerProvider` (default `5`, maximum `100`). This selection applies to all search profiles.

Separately, select the **extraction Providers** available to the Agent. Each `web_extract` call must choose exactly one enabled Provider, for example `{ "url": "https://example.com/", "provider": "direct", "format": "markdown" }`. Disabled, unconfigured, unsupported, or failed Providers do not trigger automatic fallback. Extraction Providers are enabled by default; disable any you do not want the Agent to use.

For `docs_search`, Context7 requires an explicit `library_name` or `library_id`. Without one, `provider: "auto"` uses Exa instead of guessing a package name from the full question.

## On-demand features

To see more sources from a search, ask: “Show me the other sources from this search.”

To find relevant pages on a website, ask: “Find pages about authentication on this website.” This feature requires Tavily to be configured.

The assistant uses these features when needed. You do not have to call tools manually or switch modes. To verify an important claim, you can then ask it to read the original pages.

## Update and uninstall

To update, run the installation command above again. To remove the plugin:

```bash
dsh plugin --profile web remove dsh-search-enhance
```

Restart DSH after updating or removing the bundle.
