# Search Enhance for DeepSeek Harness

English | [简体中文](README.zh.md)

`dsh-search-enhance` is a search extension for DeepSeek Harness. It uses a Grok-compatible Search API for primary web answers and can optionally use Context7, Exa, Tavily, Firecrawl, and Parallel for documentation lookup, supplementary discovery, page extraction, and site mapping.

The plugin presents search results, sources, and page content separately. Searches return an answer or documentation snippets with source links; you can ask for more sources when needed. To check important details, ask it to read the original page. Search snippets remain distinct from fetched page content.

> Bring your own service addresses and keys; none are included. Ordinary web search needs a Grok-compatible service. Other services are optional.

## Key characteristics

- `web_search` uses the Grok-compatible endpoint for the main answer and runs all user-selected supplemental Providers (Exa, Tavily, Firecrawl, Parallel) in parallel, with an independent per-Provider source limit.
- Sources are normalized, de-duplicated, and reordered using source category, requested version, and publication-time signals before they are shown.
- `web_research` uses a separate research Agent for comparisons and source checks, keeping the current model. It returns conclusions, links, excerpts, and limitations, not the full investigation history.
- In DSH Web, open research records from the original conversation's subagent entry. With history saving enabled, completed, cancelled, and failed research remains readable after restart. Records are read-only, without word-by-word updates, a running indicator, or continuation.
- `source_ref` stores complete source records separately, allowing pagination beyond the links shown initially.
- Documentation search defaults to Context7 for a named software product or documentation library, and Exa otherwise.
- `web_extract` reads through one enabled service: Tavily, Firecrawl, Parallel, smart direct reading, or direct reading. It reports the reading route, evidence level, and page details; failure does not switch services.
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

Research requires a configured, working official DeepSeek service or DeepSeek account. Other connections fail explicitly without switching services. DSH must be runnable locally for research to start.

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


Saved settings take effect immediately without restarting DSH, but may interrupt ongoing searches. A successful run shows a `Search` tool row, an answer, and source links.

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

Select any combination of **supplemental search services** in the plugin settings. Selected services run alongside the main search. Each collects up to `5` sources by default, adjustable to `100`; unselected services are not requested.

Select **available extraction services** to limit which ones the assistant may use. Each page read uses one service. Disabled services, missing keys, unsupported formats, and reading failures are reported without switching services automatically. Parallel supports Markdown only and starts disabled; other reading services start enabled and can be deselected.

Context7 needs a software name or documentation-library identifier. Without one, the default is Exa rather than guessing a software name from the whole question.


## Update and uninstall

To update, run the installation command above again. To remove the plugin:

```bash
dsh plugin --profile web remove dsh-search-enhance
```

Restart DSH after updating or removing the bundle.
