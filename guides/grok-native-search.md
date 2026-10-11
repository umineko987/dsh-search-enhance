# Grok 4.20–4.7 原生搜索：xAI 与 OpenRouter

核对日期：**2026-09-29 UTC**。本文只讨论文字输出模型的 **xAI 内建 Web Search**；X/Twitter 搜索单独注明。型号以当日 [OpenRouter 模型目录](https://openrouter.ai/api/v1/models)为准：有 `4.20`、`4.20-multi-agent`、`4.3`、`4.5`、`4.6`、`4.7`，没有单独列出的 `4.2` 或 `4.4`。`4.3:batch` 是异步批量变体，不是第七个同步对话模型。

## 结论与验证边界

- **xAI 直连**：在 `https://api.x.ai/v1/responses` 的 `tools` 中显式加入 `{"type":"web_search"}`；若还要搜 X，再单独加入 `{"type":"x_search"}`。使用 **xAI 签发的 API key**；OpenRouter key 不能代替。本轮没有 xAI key，直连写法依据官方文档，**未对 xAI 直连逐模型实测**。[xAI Web Search](https://docs.x.ai/developers/tools/web-search) · [xAI X Search](https://docs.x.ai/developers/tools/x-search) · [API 对比](https://docs.x.ai/developers/model-capabilities/text/comparison)
- **OpenRouter 上只允许 xAI 原生 Web Search、不允许回退其他搜索引擎**：本轮验证使用 `plugins: [{"id":"web","engine":"native"}]`。OpenRouter [明确写明](https://openrouter.ai/docs/guides/features/plugins/web-search#engine-selection)此处显式 `native` **始终**尝试提供商内建搜索；不支持时可能报错，不会静默选择 Exa。该接口**已标记弃用但仍可调用**。不指定 `engine` 则可能回退到 Exa。X 搜索目前需要单独 `x_search: {}` 选择加入，下面的测试**只测 Web Search**。[OpenRouter Web 插件](https://openrouter.ai/docs/guides/features/plugins/web-search)
- **OpenRouter 新 server tool 不等于严格的原生搜索开关**：`tools: [{"type":"openrouter:web_search","parameters":{"engine":"native"}}]` 的 `native` 表示**优先**原生；模型不支持时可回退 Exa。`x-ai/grok-4.20-multi-agent` 通过这条路径实测返回 HTTP 404 `No endpoints found that support tool use`，而上面的严格 `native` 插件路径成功。不能把这个路由错误解释为 xAI 模型不支持内建搜索；也不能仅以新路径请求成功就断言绝无外部搜索引擎回退。其余型号本轮**未逐一测试新路径**。[OpenRouter Server Tool](https://openrouter.ai/docs/guides/features/server-tools/web-search) · [xAI Multi-Agent 内建工具与限制](https://docs.x.ai/developers/model-capabilities/text/multi-agent)

## 逐型号 OpenRouter 实测

测试使用一把经认证可用的 OpenRouter key（**密钥及其片段均未写入本文**），向 `POST https://openrouter.ai/api/v1/chat/completions` 发送同一条简短请求，`stream: true`，明确设置 `plugins: [{"id":"web","engine":"native"}]`。除 `grok-4.20` 外使用 `reasoning: {"effort":"low"}` 控制成本。判定成功要求 **HTTP 200、流以 `[DONE]` 结束、`finish_reason: stop`、响应流含 `url_citation` 注释**；引用数不等于搜索调用次数。请求会产生模型及原生搜索费用；一次测试不能保证未来路由不变。

| OpenRouter 模型 ID | xAI 官方可请求型号 | 严格原生 Web Search 实测 | `url_citation` 数 |
| --- | --- | --- | ---: |
| `x-ai/grok-4.20` | `grok-4.20`（别名） | HTTP 200、完整结束 | 1 |
| `x-ai/grok-4.20-multi-agent` | `grok-4.20-multi-agent`（别名） | HTTP 200、完整结束 | 1 |
| `x-ai/grok-4.3` | `grok-4.3` | HTTP 200、完整结束 | 1 |
| `x-ai/grok-4.5` | `grok-4.5` | HTTP 200、完整结束 | 1 |
| `x-ai/grok-4.6` | `grok-4.6` | HTTP 200、完整结束 | 10 |
| `x-ai/grok-4.7` | `grok-4.7` | HTTP 200、完整结束 | 1 |
| `x-ai/grok-4.3:batch` | `grok-4.3` 的 batch 变体 | 同步 Chat Completions 返回 HTTP 404：`cannot be used with the chat/completions endpoint`；**未测试异步 Batch 搜索** | — |

`:batch` 应使用异步 [Batch API](https://openrouter.ai/docs/batch-quickstart)，不能拿同步 404 推断其异步搜索能力。OpenRouter Batch 文档指出 `web` 插件不适用于批处理，只有符合条件、由提供商自己执行的原生搜索工具可能透传；本轮未提交/轮询任何 Batch 作业。

可复现的同步请求模板（仅替换模型 ID 和**自行提供的** key，不要把 key 写入仓库；需要降低 Multi-Agent 费用时加 `"reasoning":{"effort":"low"}`）：

```json
{
  "model": "x-ai/grok-4.20-multi-agent",
  "messages": [{"role":"user","content":"Use your built-in web search to find the official xAI Web Search API documentation. Give the page title and cite its URL. Be concise."}],
  "stream": true,
  "reasoning": {"effort":"low"},
  "plugins": [{"id":"web","engine":"native"}]
}
```

这条 OpenRouter `plugins` 路径是其内建搜索转发配置，**不是**客户端自定义函数工具，也没有在请求中加入 Exa/Firecrawl/Parallel。带引用的成功结果结合文档所述严格 `native` 语义，是此次验证 xAI 原生搜索可用的依据；响应本身未提供独立的 `engine_used` 审计字段。本文不声称验证了每个型号在 **xAI 直连**时的实际账单或工具调用次数。

## xAI 官方 API：开启方式

使用 `POST https://api.x.ai/v1/responses`，提供 xAI 自己的 key。仅搜网页：

```json
{
  "model": "grok-4.20-multi-agent",
  "input": [{"role":"user","content":"Search the web for the latest official xAI documentation and cite sources."}],
  "tools": [{"type":"web_search"}],
  "reasoning": {"effort":"low"}
}
```

同时允许 X/Twitter 搜索时再添加 `{"type":"x_search"}`。启用工具不意味着每个问题都会调用；应查看返回的引用和工具用量。官方 [Web Search 指南](https://docs.x.ai/developers/tools/web-search)以 `grok-4.7` 演示相同写法，[Multi-Agent 指南](https://docs.x.ai/developers/model-capabilities/text/multi-agent)则明确以 `grok-4.20-multi-agent` 演示 `web_search` / `x_search`。xAI SDK 的 `chat.create(tools=[web_search()])` 也支持内建工具；**不要**把它混同于已弃用的 OpenAI 风格 `POST /v1/chat/completions`：后者仅有函数调用，没有 Responses 的原生搜索等 agentic tools，Multi-Agent 本身也不支持该 Chat Completions API。[xAI API 对比](https://docs.x.ai/developers/model-capabilities/text/comparison) · [Multi-Agent 限制](https://docs.x.ai/developers/model-capabilities/text/multi-agent#limitations)

官方型号资料：[4.20](https://docs.x.ai/developers/models/grok-4.20) · [4.20 Multi-Agent](https://docs.x.ai/developers/models/grok-4.20-multi-agent) · [4.3](https://docs.x.ai/developers/models/grok-4.3) · [4.5](https://docs.x.ai/developers/models/grok-4.5) · [4.6](https://docs.x.ai/developers/models/grok-4.6) · [4.7](https://docs.x.ai/developers/models/grok-4.7)。官方型号页并未为这六个 ID 各自列出单独的 Web Search 能力矩阵；上表的逐模型结果是 **OpenRouter 路径**的实测，不是 xAI 直连实测。

## 对当前 DSH 插件的意义

当前实现对 OpenRouter 上的 Grok 使用 `plugins: [{"id":"web","engine":"native"}]`，沿用用户选择的 `completions` / `responses` 协议；xAI 直连仍使用 `web_search` / `x_search`。此前 `openrouter:web_search` server tool 在 `grok-4.20-multi-agent` 上实测返回 HTTP 404，严格 `native` 插件路径则成功。OpenRouter 将此插件接口标为弃用；将来如果移除，必须重新验证不回退外部搜索引擎的替代入口。
