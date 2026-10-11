# DeepSeek Harness Search Enhance

[English](README.md) | 简体中文

`dsh-search-enhance` 是 DeepSeek Harness 的搜索增强插件。它使用 Grok-compatible Search API 生成普通网页搜索的主要回答，并可选用 Context7、Exa、Tavily、Firecrawl 和 Parallel 完成文档检索、补充来源、网页正文提取和站点页面发现。

插件将搜索结果、参考来源和网页正文分开呈现。搜索时先给出回答或文档片段及来源链接，需要更多来源时可以继续追问；核对重要内容时，再要求读取原网页。搜索摘要与实际读取的正文会明确区分。

> 需自行提供服务地址和密钥，插件不附带密钥。普通网页搜索需要 Grok-compatible 服务，其他服务按需配置。

## 主要特点

- `web_search` 使用 Grok-compatible 端点生成主要回答，并行调用用户勾选的全部补充搜索 Provider（Exa、Tavily、Firecrawl、Parallel），每家使用独立的来源数量上限。
- 来源在展示前会经过 URL 标准化、去重，并根据来源类别、目标版本和发布时间信号重新排序。
- `web_research` 由独立研究 Agent 完成多步比较和来源核对，沿用当前模型；返回结论、链接、摘录和局限，不带回完整调查历史。
- DSH Web 可从原对话的子智能体入口查看研究记录。启用历史保存后，完成、取消或失败的研究在重启后仍可查看；记录只读，不支持逐字更新、状态灯或继续执行。
- `source_ref` 单独保存完整来源记录，可继续分页查看首次回答未展示的来源。
- 文档检索默认在明确指定软件名称或文档库时使用 Context7，否则使用 Exa。
- `web_extract` 每次读取一家已启用服务（Tavily、Firecrawl、Parallel、智能直连或直连），说明读取路径、证据等级和页面信息；失败不自动换服务。
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

研究仅支持已配置且能正常使用的 DeepSeek 官方服务或 DeepSeek 账号，其他接入方式会明确失败，不自动切换。运行研究需要本机能启动 DSH。

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

保存后设置立即生效，无需重启 DSH，但可能中断正在进行的查询。成功时会看到 `Search` 工具行、回答和来源链接。

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

在插件设置中多选 **补充搜索服务**，所选服务会与主搜索并行执行。每家默认最多收集 `5` 条来源，可调整至 `100` 条；未勾选的服务不会被请求。

多选 **可用网页提取服务**，可以限制助手读取网页时使用的服务。一次只用一家，禁用、缺少密钥、不支持格式或读取失败都会明确报错，不自动换服务。Parallel 仅支持 Markdown，默认关闭；其他读取服务默认开启，可取消勾选。

Context7 需要明确的软件名称或文档库标识。未指定时，默认使用 Exa 查找，不从整句问题里猜软件名称。

## 更新与卸载

更新时重新运行上面的安装命令。卸载插件：

```bash
dsh plugin --profile web remove dsh-search-enhance
```

更新或卸载 bundle 后请重启 DSH。
