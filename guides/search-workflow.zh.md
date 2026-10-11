# 搜索链路架构

[English](search-workflow.md) | 简体中文

本文说明 Search Enhance 如何将一次请求从来源发现推进到来源保留和原文核对。安装与配置以主 [README](../README.zh.md) 为准。

## 整体流程

```text
用户请求
  │
  ▼
DSH Agent
  │
  ├─ web_search ──────> Grok-compatible Search API
  │                       ├─ 并行调用选中的 Exa / Tavily / Firecrawl / Parallel
  │                       └─ 回答 + 标准化来源 + 可选 source_ref
  │
  ├─ docs_search ─────> Context7：使用明确的库身份
  │                       └─ Exa：广泛或未知库身份的文档发现
  │                          └─ 文档片段 + 来源 + 可选 source_ref
  │
  ├─ web_extract ─────> 显式指定一家用户已启用的 Provider
  │                       └─ 网页正文 + 路径元数据，或报错（不回退）
  │
  ├─ search_sources ──> 保留来源分页（下一步自动披露）
  │
  └─ web_research ────> 独立研究 Agent（沿用 Provider / 模型）
                          ├─ 搜索 / 文档 / 正文 / 来源分页 / 站点映射
                          └─ 经校验报告：结论 + URL + 摘录 + 局限
```

插件将发现、保留和核对分成三个阶段：

1. **来源发现：** `web_search` 和 `docs_search` 查找回答、文档片段和候选 URL。这些内容属于发现元数据，并不能证明页面确实包含某项声明。
2. **来源保留：** 完整且有界的来源记录可以保存在 `source_ref` 下，不受首次工具结果能够展示多少链接的影响。
3. **原文核对：** `web_extract` 读取选中的页面，使 Agent 能区分“Provider 找到了这个结果”和“实际读取的页面写了这些内容”。

读取博客、新闻、仓库 README 和模型卡等网页正文时，优先使用 `web_extract`；读取 JSON API、arXiv XML/Atom 等结构化响应时，优先使用宿主提供的 `web_fetch`（若可用）。优先直接使用 HTTPS。HTTP 200 但仅有标题或应用空壳，不算取得有效正文，应明确选择合适的已启用提取服务，而不是反复读取同一空壳。不要绕过 URL 安全检查。
## 一次完整搜索

一次带来源的回答通常按以下流程完成：

1. Agent 将普通时效性问题交给 `web_search`，将文档问题交给 `docs_search`。
2. `web_search` 同时启动 Grok-compatible 主搜索和用户勾选的全部补充 Provider。Exa、Tavily、Firecrawl、Parallel 各自使用相同的独立来源数量上限，未选中的服务不会被请求，query 不会隐式启用其他服务。
3. 搜索来源会受到数量和体积限制并经过标准化。网页搜索质量流程会合并等价 URL，并可优先展示官方、第一方、版本匹配和较新的来源。
4. `docs_search` 直接使用传入的 `library_id`，通过 Context7 解析传入的 `library_name`；当库身份未知且选择 `provider: "auto"` 时则使用 Exa。
5. 完整来源记录成功保留后，结果包含 `source_ref`。下一 step 自动提供 `search_sources`，可直接分页。
6. 对重要结论，Agent 选择权威 URL，并从工具描述列出的可用服务中明确指定一家 `provider` 调用 `web_extract`。只执行这家服务；不可用、不支持格式或执行失败时，不会自动切换路径。
7. 需要在已知网站下发现 URL 时，通过 `web_research` 委托；只有专用研究 Agent 能调用 `web_map`。
8. Agent 综合主搜索、保留来源和实际读取的网页正文生成最终回答，同时保留来源链接，并区分来源发现与已读取证据。

`source_ref` 指向来源列表，不等同于网页正文。在条件允许时，结论级事实应由 `web_extract` 读取选中页面后再确认。

## 实现位置

- 插件装配与生命周期：[`src/index.ts`](../src/index.ts)
- 主搜索编排：[`src/orchestration/orchestrator.ts`](../src/orchestration/orchestrator.ts)
- 文档路由：[`src/documentation/service.ts`](../src/documentation/service.ts)
- 来源保留与分页：[`src/source-storage/`](../src/source-storage/)
- 能力映射：[`src/tool-discovery/capabilities.ts`](../src/tool-discovery/capabilities.ts)
- 显式网页提取路由：[`src/web-extract/orchestrator.ts`](../src/web-extract/orchestrator.ts)
- 专用研究生命周期与报告：[`src/research/`](../src/research/)
