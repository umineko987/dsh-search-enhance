# DeepSeek Harness Search Enhance

[English](README.md) | 简体中文

`dsh-search-enhance` 是 DeepSeek Harness 的搜索增强插件。它使用 Grok-compatible Search API 生成普通网页搜索的主要回答，并可选用 Context7、Exa、Tavily、Firecrawl 和 Parallel 完成文档检索、补充来源、网页正文提取和站点页面发现。

插件将搜索结果、参考来源和网页正文分开呈现。搜索时先给出回答或文档片段及来源链接，需要更多来源时可以继续追问；核对重要内容时，再要求读取原网页。搜索摘要与实际读取的正文会明确区分。

> 你需要自行提供所选服务的端点和凭据，插件不内置任何 API Key。`web_search` 需要 Grok-compatible 端点；Context7、Exa、Tavily、Firecrawl 和 Parallel 均为可选 Provider。

## 主要特点

- `web_search` 使用 Grok-compatible 端点生成主要回答，并行调用用户勾选的全部补充搜索 Provider（Exa、Tavily、Firecrawl、Parallel），每家使用独立的来源数量上限。
- 来源在展示前会经过 URL 标准化、去重，并根据来源类别、目标版本和发布时间信号重新排序。
- `web_research` 把多步比较与来源核对委托给独立研究 Agent，沿用父 Agent 的 Provider 和模型；返回结论、URL、证据摘录和局限，不把子 Agent 的工具历史搬回主上下文。
- 在 DSH Web 中，可从父会话的原生子智能体入口打开 `web_research`，只读查看已提交的消息、工具调用和结果。宿主启用会话持久化时，完成、取消或失败的研究在重启后仍可回看。过程不是逐字更新，不提供原生运行状态灯或继续执行。
- `source_ref` 将完整来源记录保存在插件私有持久存储中，Agent 可以继续分页读取首次结果未展示的来源。
- `docs_search` 只在提供明确 `library_name` 或 `library_id` 时使用 Context7；没有库身份的请求使用 Exa 发现。
- `web_extract` 每次必须通过 `provider` 指定一家用户已启用的服务：`tavily_extract`、`firecrawl_scrape`、`parallel_extract`、`smart_direct` 或 `direct`。结果报告提取路径、证据等级和页面元数据，失败不自动换服务。
- 成功搜索保留了可读来源后，下一步自动启用来源分页；站点映射仅提供给研究 Agent，主 Agent 不直接持有该工具，无需手动加载器。
- 补充搜索默认不选择任何 Provider。未选中的服务不会被请求；选中服务缺少凭据或执行失败会在结果中显示警告。

实现细节见[搜索链路架构](https://github.com/umineko987/dsh-search-enhance/blob/main/guides/search-workflow.zh.md)。

## 快速开始

### 1. 安装

支持 DSH `0.2.0-rc.2`，DSH 依赖精确锁定到该版本；使用旧版本时，请先升级 DSH CLI。

将 [npm 上发布的 bundle](https://www.npmjs.com/package/dsh-search-enhance) 安装到 DSH `web` profile：

```bash
dsh plugin --profile web add dsh-search-enhance@latest
```

bundle 提供官方子 Agent 服务，研究在使用临时 profile 的独立 SDK 子进程中执行。目前研究仅支持显式配置、认证可用的 `deepseek-official` 和 `deepseek-account` 路由；其他路由会明确失败，不自动回退。需要可运行的 DSH CLI。

### 2. 启动 DSH Web

```bash
dsh web
```

### 3. 配置搜索

打开：

```text
设置 → 插件 → 插件配置 → dsh-search-enhance
```

在设置卡片中配置：

1. 在 **凭据 → Grok 搜索** 中填写 xAI 端点或明确的 Grok-compatible 网关及密钥；
2. 在 **Grok 搜索后端** 中选择匹配的 `completions` 或 `responses` 协议及模型；
3. 用 **补充搜索服务** 和 **可用网页提取服务** 的下拉框多选需要的服务。其他服务的接口地址、超时和凭据引用也位于各自的凭据卡片中。

搜索使用一份固定默认策略，不再提供搜索 Profile、depth 或分档预算设置。工具加载模式、文档结果数量和超时仍可独立配置。

默认凭据引用名是 `SEARCH_API_KEY`。密钥值通过 DSH Credentials 保存，不会暴露为模型参数。

官方 Grok 端点会自动启用原生搜索，无需新增协议或开关：
- 版本路径可省略：`https://api.x.ai` / `https://us.api.x.ai` 自动补 `/v1`；`https://openrouter.ai` 自动补 `/api/v1`，填到 `/api` 时补 `/v1`。搜索与模型列表请求都会补全，不重复追加完整路径，也不改写自定义中转地址。
- **xAI**：`https://api.x.ai/v1`（也支持 `https://us.api.x.ai/v1`），模型如 `grok-4.6`。自动使用 Responses 并发送 `web_search` + `x_search`，即使设置选择了 `completions`；不改写已保存的设置。
- **OpenRouter**：`https://openrouter.ai/api/v1`，模型如 `x-ai/grok-4.6`。保留所选协议，发送 `plugins: [{ "id": "web", "engine": "native" }]` 请求原生 Web Search，不静默回退 Exa，无需 `:online` 后缀。此插件接口已标记弃用，但仍是当前使用的路径；不支持的模型或路由可能报错。已测型号及其与新 server tool 的区别见[原生搜索兼容说明](https://github.com/umineko987/dsh-search-enhance/blob/main/guides/grok-native-search.md)。
- 只对上述官方 HTTPS 域名及 Grok 模型启用原生搜索；自定义网关使用所选协议。官方适配中 `minimal` 映射为 `low`、`max` 映射为 `xhigh`，`off` 表示省略思考参数。
- 结构化引用会进入来源列表。若 API 未报告完成的搜索、结构化引用或搜索用量，结果会明确提示原生搜索未确认；正文链接本身不作为执行证明。

保存设置后即可询问一个需要当前信息的问题。保存配置时 DSH 会在进程内自动热重载本插件，配置立即生效，无需重启 DSH；正在执行的插件请求可能被中断。成功时会看到 `Search` 工具行、回答和来源链接。

## 使用示例

直接使用自然语言即可，插件会为 Agent 提供路由指引。

- “查找 React 19 最重要的用户可见变化，优先引用官方发布说明并附上来源链接。”
- “查找 FastAPI 当前 JWT 认证 API，并根据官方文档给出最小示例。”
- “读取并总结 `https://example.com/article`，区分页面原文与推断。”
- “深度比较这三种方案，交叉核对关键结论，返回来源摘录与尚未解决的局限。”

需要更多参考来源或网站内的相关页面时，可以继续追问；服务配置状态可在插件设置中查看。

## Provider

只配置你实际需要的路径。

| Provider | 用途 | 默认凭据引用名 | 是否必需 |
| --- | --- | --- | --- |
| Grok-compatible Search API | `web_search` 的主要回答和来源 | `SEARCH_API_KEY` | 使用 `web_search` 时 |
| Context7 | 明确库身份的文档检索 | `CONTEXT7_API_KEY` | 否 |
| Exa | 广泛文档发现和补充发现 | `EXA_API_KEY` | 否 |
| Tavily | 补充搜索、网页提取和站点映射 | `TAVILY_API_KEY` | 否 |
| Firecrawl | 补充搜索和网页提取 | `FIRECRAWL_API_KEY` | 否 |
| Parallel | 补充搜索和 Markdown 网页提取 | `PARALLEL_API_KEY` | 否 |

在插件设置中，可以多选 **补充搜索 Provider**。选中项与主搜索并行执行，每家使用 `supplementalSearch.maxSourcesPerProvider` 限制来源数量（默认 `5`，最大 `100`）。

另外，多选 **网页提取 Provider** 可以限制 Agent 可用的服务范围。每次 `web_extract` 必须明确选择一家已启用服务，例如 `{ "url": "https://example.com/", "provider": "direct", "format": "markdown" }`。服务被禁用、缺少凭据、不支持格式或执行失败时，直接报告错误，不自动回退。Parallel 提取仅支持 Markdown，默认关闭，需要手动启用；其他提取服务默认启用，可取消勾选不希望使用的服务。

对于 `docs_search`，Context7 需要明确的 `library_name` 或 `library_id`。两者都未提供时，`provider: "auto"` 使用 Exa，不会根据完整问题猜测包名。

## 按需功能

想查看更多搜索来源时，可以直接追问：“把这次搜索的其他来源也列出来。”

想查找某个网站下的相关页面时，可以提出：“查找这个网站下与认证有关的页面。”主 Agent 会通过 `web_research` 委托研究 Agent；站点映射需要先配置 Tavily。

助手会按需使用这些功能，你不必手动调用工具或切换模式。核对重要结论时，还可以继续要求读取原网页。

`web_research({ query, timeout_ms? })` 由主 Agent 为每次调用选择总预算：整数毫秒，范围 60000–3600000（1–60 分钟），默认 600000（10 分钟）。例如 `{ "query": "用一手来源比较这三种方案，并列出尚未证实的结论。", "timeout_ms": 1200000 }` 为本次调用提供 20 分钟，包括创建、思考、检索和报告。简单事实查询直接搜索。总预算的最后 20%、最多 2 分钟自动留给报告收尾；默认第 8 分钟禁止新检索，第 10 分钟触发硬取消。单次工具超时独立生效。

研究提示词要求首轮进行一次聚焦搜索，之后优先复用已保留来源、读取原网页。补搜必须针对现有来源无法解决的明确证据缺口。这是提示词约束，不是硬性搜索次数上限；时间预算也不是搜索配额。

模型生成的工具参数 JSON 不合法时，可在同一研究会话中对失败的模型生成最多重试两次，不重放此前已成功的搜索和提取，仍消耗原时间预算。报告继续严格校验，不自动修补；提示词要求简洁结论、短摘录和正确 JSON 转义。

部分报告使用 `stop_reason: budget_exhausted`，并列出未完成事项；提前提交的报告使用 `completed` 或 `evidence_limited`。已开始的请求可以完成，但模型卡住、报告缺失或不合格、硬预算耗尽且没有已接受的报告、取消仍可能失败。调用方取消与插件重载优先于成功；硬取消无法强制不响应取消的 IO 立即结束，清理可能晚于截止。更长时间不保证证据质量更高。

## 更新与卸载

更新时重新运行上面的安装命令。卸载插件：

```bash
dsh plugin --profile web remove dsh-search-enhance
```

更新或卸载 bundle 后请重启 DSH。
