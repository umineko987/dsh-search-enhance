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

同一模型 step 内，独立的 `web_search` 和 `web_extract` 调用允许按 DSH 的并发上限重叠执行；来源记录通过串行队列写入，彼此的调用身份和来源引用保持独立。

`web_search` 只接受 `query`，使用一份按查询内容调整重点的固定提示词，不再暴露搜索 Profile 和 depth。输出上限固定为回答 6,000 字符、首屏 8 个来源、模型可见文本 12 KiB；来源收集和已保留来源的分页仍独立。工具加载模式、文档结果数量和工具超时继续可配置。

## 主 Agent 与研究 Agent 的工具职责

主 Agent 和普通子 Agent 提供 `web_search`（仅在宿主允许时）、`docs_search`、`web_extract`、`web_research`。定义仅注册在 Agent 局部作用域，不全局暴露。快速检索、库文档和已知 URL 使用直接工具；多步调查通过 `web_research` 提交自包含的问题与约束。

专用研究 Agent 首次请求前即持有 `web_search`、`docs_search`、`web_extract`、`search_sources`、`web_map` 和插件定义的 `structured_output` 报告工具。它不持有 `web_research`、通用子 Agent 创建、shell、文件编辑或其他宿主工具。宿主创建的普通子 Agent 使用普通角色；来源标签与继承文本不能授予研究身份。

研究提示词将每次 `web_search` 视为有成本的来源发现：首轮尽量用一次聚焦查询覆盖关键点，之后优先分页已保留来源、提取原文。仅在存在重要且已知来源无法补足的证据缺口时补搜；避免换词重复搜索、重叠查询或让 Grok 重新总结已有材料。证据足够就提前结束检索。这是提示词指引，不是运行时搜索次数限制。

默认 `toolDiscovery.mode: progressive` 下，成功的结构化来源调用保留了可读记录后，仅在 `step/end` 自动启用 `search_sources`，供下一模型 step 使用。失败、空来源、缺失或无权读取的引用、普通文本均不会触发。`all` 仅为主/普通 Agent 提前启用来源分页，不提供 `web_map`。研究工具集不受该设置影响。

Native Mode 使用真实 schema，Code Mode 通过 `run_code` 提供同一组 SDK 定义。参数校验、策略 guard、展示与真实工具名的执行由 DSH 负责，普通 Agent 的 `web_search` 是否可用由宿主决定。恢复与 HMR 使用配对的标准 Native/PTC 事件、完整私有调用身份和来源授权，不解析结果文本，不使用自定义 SessionEvent。

## 研究生命周期与报告

`web_research({ query, timeout_ms? })` 使用官方 `dsh-subagent-dsh-sdk` 后端，每次调用创建独立临时 home 和 profile。子 Agent 接收父级显式配置的官方 DeepSeek 路由及模型选项，不继承父对话或工具历史。profile 在首次模型请求前注册五个研究工具和报告提交工具，不挂载 shell、文件系统、委派或宿主凭据文件插件。

临时 profile 加载官方 `@deepseek-ai/dsh-llm-retry` 插件。研究使用固定的 `normal` 重试策略覆盖继承值：`maxRetries: 2`、`retryableCodes: ["MALFORMED_RESPONSE"]`。模型请求失败时（包括工具参数 JSON 不合法），最多生成三次，保留之前的工具结果，不重新启动研究或重放已完成调用。该策略不增加其他错误码的重试。取消与原硬截止仍生效；失败生成不构成成功工具调用或模型上下文消息，不执行 JSON 修补，报告结构和证据字段仍须通过校验。

主 Agent 可在每次调用传入可选 `timeout_ms`：整数毫秒，范围 60000–3600000（1–60 分钟），默认 600000（10 分钟），独立于 `toolTimeoutMs`。例如 `web_research({ query: "用一手来源比较三种方案，列出冲突与未证实结论。", timeout_ms: 1200000 })` 为本次调用选择 20 分钟。按任务复杂度选择，更长时间不保证证据更强。计时从创建子 Agent 前开始，包括思考、检索和报告；每次调用的预算固定。只收尾窗口为 `min(timeout_ms × 20%, 120000)`：默认在 480000 ms（第 8 分钟）软截止，600000 ms（第 10 分钟）硬取消。

软截止后，子 Agent 通过官方 inbox/pre-step API 注入带插件身份的通知。执行 guard 拒绝新检索，包括截止前生成、截止后才执行的调用。研究子进程固定使用 Native mode，保留 `structured_output` 用于报告；已开始的 IO 可以完成并提供证据。父 Agent 可通过 Native 或 Code mode 调用 `web_research`。

通知在下一次实际准入的 step 对模型可见，不能改写正在执行的请求，也不保证连续重试能恢复。模型一直卡到硬截止且未提交有效报告时失败。宿主执行层自身超时独立生效，实际调用可能先被宿主取消。

只有通过校验且被 SDK 正式接受的结构化报告才可成功。收尾报告使用 `stop_reason: budget_exhausted`，且非空 `limitations` 说明尚未完成/验证的事项或缺少证据的原因；提前报告使用 `completed` 或 `evidence_limited`。空结论必须解释为何无证据。已正式接受的有效报告不会仅因 SDK 结束阶段与硬预算竞态而丢失。调用方取消与插件卸载始终优先于成功。硬取消走官方 SDK 关闭与排空流程，不响应取消的 IO 可能使结果结算和清理晚于截止；缺失、不合格、中断或非结构化输出不会被伪造成成功报告。

报告包含结论、URL、摘录、`reading`（`full_text` / `summary_only`）、局限及停止原因。提示词要求聚焦结论、短而相关的摘录和严格 JSON 转义，包括代码片段内的引号与反斜杠；Markdown 反引号不能替代 JSON 转义。插件不限制报告的字符数、条目数或总字节数，仍校验结构及证据字段。报告区分摘要证据与全文证据，并应说明尚未解决的证据局限。读取标签是模型声明，不是独立核验过的读取证明。子 Agent 的 `source_ref` 不转交父 Agent；返回的 URL 和摘录才是可复用证据，需进一步核实时可重搜或提取这些 URL。

bundle 在同一 entry group 没有启用的标准宿主子 Agent 服务时挂载官方服务。每次研究调用独立持有 SDK 后端、回环报告通道和临时 profile，完成、取消或卸载后释放；运行时包锁定 DSH `0.2.0-rc.2`。目前仅支持可通过公开配置访问的 `deepseek-official` / `deepseek-account` 路由；认证缺失或不支持的路由在启动子进程前失败。自带子 Agent 服务的自定义组合应禁用 `search-enhance-subagents` 回退行。

临时 profile 链接本包导出的 `research-child` 入口，不复制或修改用户 profile。模型认证和配置的搜索凭据通过每次调用独立的认证回环通道在内存中传递，不写入 profile 文件，也不经过宿主 LLM 中间件。SDK 后端没有暴露客户端事件流，该通道分别回传正式接受的报告和批量提交的子会话 SessionEvent。最终报告仍是父级工具返回；展示历史不进入父模型上下文。

## 只读研究历史

子侧通过公开的 `session/created` 和 `session/event` hook 捕获唯一研究会话，在首次准入 step 前写入标准 `subagent/descriptor`。发送的是完整、已提交的生命周期事件，不是 assistant 字流。每次调用的认证通道和宿主生成的研究 ID 与父级绑定；首次观察后锁定远端会话 ID 和创建时间。串行批次保留原始事件序号、payload、`surfaceOp` 和 `sourceEventSeqs`。相同重试去重，冲突重试或断档明确关闭观察。step 边界背压和有界传输尝试避免观察队列累积整个调查过程。

宿主存在 `sessions` 和 `sessionProjections` 服务时，插件仅创建展示 Session，不创建可执行的宿主研究 Agent。副本沿用父级稳定的工作目录和实际委派深度，标明 `origin: subagent`、`parentSession`、`isSeeded: false`，使用 `mode: one-shot`。宿主先取得持久 writer，再发布事件；初始 descriptor flush 后才追加父级标准 `subagent/catalog`。原生 `listChildren`、`follow` 和 `page` 通过 `{ kind: "subagent", parentSessionId, childSessionId, mode: "one-shot" }` 读取；DSH Web 使用已有导航和只读输入区。错误父级和普通会话地址不能激活镜像，继续执行也被拒绝。公开 `Session.append` 使用宿主接收时间；原始事件顺序与引用保持不变。

完成、取消、卸载或进程异常时，官方 SDK 先停止并回收子进程，再关闭宿主观察。取消后仍允许排空已提交观察及结束通知，但拒绝新凭据、模型认证和调用方已取消的报告。宿主排空串行队列，对未闭合前缀使用官方 `interruptedTurnClosers`（未知工具结果和中断 turn，不伪造成功），flush 并关闭 writer，再 detach 已持久化实时镜像，最后关闭通道及删除临时 profile。目录与历史保存在宿主持久存储中，重启后可冷读。

展示服务是可选依赖：缺少会话存储/投影时跳过镜像，不阻止研究；没有会话持久化时，历史只保留到所属插件被销毁。该功能不安装 Web UI。观察故障保留已有可读前缀，但不构成或替代成功报告。展示不会授予父级读取子 `source_ref` 的权限。本集成只提供已提交事件更新，不提供逐字流式输出、原生运行状态灯、恢复研究执行或另建聊天 UI。

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
