# dsh-opencontext

[![npm version](https://img.shields.io/npm/v/dsh-opencontext.svg)](https://www.npmjs.com/package/dsh-opencontext)

为 DeepSeek Harness (DSH) agent 提供持久化记忆与检索增强上下文的插件,
基于 [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)。

- **包名**:`dsh-opencontext`
- **协议**:Apache-2.0
- **Node 版本**:`^22.19.0 || >=24.0.0`
- **工具前缀**:`oc_*`
- **技能**:`opencontext`
- **命令**:`/oc doctor`

## 安装

### 从 npm 安装（推荐）

```bash
# 直接从 npm 安装
dsh plugin --profile web add dsh-opencontext

# 确认已挂载
dsh --profile web --dump-config
#   ... 应包含 `id: dsh-opencontext`

# 启动 DSH web 并验证
dsh --profile web web
#   访问 http://127.0.0.1:3080/plugins，确认 dsh-opencontext 显示 "Enabled"
```

### 从源码安装（开发用）

```bash
# 1. 进入插件目录
cd /path/to/opencontext/plugins/dsh-opencontext

# 2. 构建插件(生成 lib/)
pnpm install
pnpm build

# 3. 注册到 DSH profile
dsh plugin --profile web add /path/to/opencontext/plugins/dsh-opencontext

# 4. 确认已挂载
dsh --profile web --dump-config
#   ... 应包含 `id: dsh-opencontext`

# 5. 启动 DSH web 并验证
dsh --profile web web
#   访问 http://127.0.0.1:3080/plugins，确认 dsh-opencontext 显示 "Enabled"
```

## 功能

### 核心工具(8 个)

| 工具 | 用途 |
|---|---|
| `oc_search` | 在长期记忆(memory + insights + knowledge)中检索。 |
| `oc_remember` | 用户明确要求时,持久化一条记忆。 |
| `oc_memory_list` | 列出当前作用域的近期记忆条目。 |
| `oc_memory_get` | 通过 id 读取一条或多条记忆。 |
| `oc_memory_revise` | 软废弃旧条目,存储新内容作为后继。 |
| `oc_memory_retire` | 软废弃一条记忆。 |
| `oc_prepare_context` | 手动构建一个字节受限的 `<opencontext_evidence>` 上下文块。 |
| `oc_capture_source` | 捕获任意内容源以供后续检索。 |

### 摘要与结果工具(3 个)

| 工具 | 用途 |
|---|---|
| `oc_session_summary` | 在自然断点生成并存储会话摘要。 |
| `oc_task_outcome` | 记录任务结果、决策与成就。 |
| `oc_recent_summaries` | 列出近期会话摘要与任务结果。 |

### Insights 工具(2 个,可选)

| 工具 | 用途 |
|---|---|
| `oc_insights_search` | 检索结构化 insights(决策、偏好、结果)。 |
| `oc_insight_capture` | 从对话中捕获结构化 insight。 |

### Knowledge/RAG 工具(3 个,可选)

| 工具 | 用途 |
|---|---|
| `oc_knowledge_search` | 对已上传文档进行 RAG 检索。 |
| `oc_document_upload` | 上传文档到知识库。 |
| `oc_document_list` | 列出知识库中的所有文档。 |

所有工具成功时返回 `{ ok: true, value }`,失败时返回
`{ ok: false, error: { code, message } }` —— 永远不向模型抛出异常。

### 召回流水(Recall Waterfall)

每次 `agent/pre-step` 事件触发一次召回:

1. 从最后一条用户消息中提取查询(截断到 256 字符)。
2. 调用 `backend.search({ query, limit: maxRecallItems, ... })`,
   由 `requestTimeoutMs` 限定超时。
3. 将命中格式化为一个带 `<opencontext_evidence>` 围栏的块,字节
   上限为 `maxBytes`(默认 8000)。
4. 该块作为**插件来源的用户消息**追加到对话,头部明确标注为
   **不可信的历史证据**。
5. 任何后端错误都会被记入警告日志,本轮对话继续进行。

### 自动捕获

第二个 `agent/pre-step` 监听器在召回之后执行,将每条用户消息写入
存储,标记为 `sourceType: "user_input"`。受 `config.capturePrompts`
控制(默认 `true`,可设 `OPENCONTEXT_DSH_CAPTURE_PROMPTS=0` 禁用)。
默认采用 fire-and-forget 模式,不会阻塞轮次;如需严格顺序,
可开启 `flushOnCapture: true`。

### 轮次结束摘要

开启 `autoSummarize` 后,`turn/end` 监听器会:
1. 生成当前轮次的简要摘要
2. 将其存储为 `turn-summary` 记忆
3. 若启用 `captureToolOutcomes`,同时捕获工具结果

### 工具结果捕获

开启 `captureToolResults` 后,`tool/result` 监听器会将工具调用结果
捕获为 `tool-interaction` 记忆,形成可检索的工具交互日志。

### 技能:`opencontext`

在 `apply` 时注册。让模型在每次会话开始时即了解召回/捕获约定、
信任模型与全部 16 个 `oc_*` 工具的语义。

### 命令:`/oc doctor`

输出 JSON 状态:

```json
{
  "ok": true,
  "plugin": "dsh-opencontext",
  "backend": "lib",
  "scope": "local:9cd22c419df9",
  "db": "/Users/you/.opencontext/memory/store.db",
  "probe": { "ok": true, "mode": "lib", "details": "db=/Users/you/.opencontext/memory/store.db" },
  "recentCount": 0,
  "features": ["insights", "knowledge", "prompt-capture"]
}
```


## 配置

按以下顺序解析(优先级从高到低):

1. `cordis.patch.yml` 中 `id: dsh-opencontext` 的 `config` 块
2. `OPENCONTEXT_DSH_*` 环境变量
3. `ConfigSchema` 中的默认值

| 字段 | 类型 | 默认值 | 环境变量 |
|---|---|---|---|
| `baseUrl` | string | `http://127.0.0.1:8000` | `OPENCONTEXT_DSH_BASE_URL` |
| `authorization` | string | `""` | `OPENCONTEXT_DSH_AUTHORIZATION` |
| `scopeId` | string | `""` (自动) | `OPENCONTEXT_DSH_SCOPE_ID` |
| `timeoutMs` | number | `4000` | `OPENCONTEXT_DSH_TIMEOUT_MS` |
| `requestTimeoutMs` | number | `1000` | `OPENCONTEXT_DSH_REQUEST_TIMEOUT` |
| `maxBytes` | number | `8000` | `OPENCONTEXT_DSH_MAX_BYTES` |
| `capturePrompts` | bool | `true` | `OPENCONTEXT_DSH_CAPTURE_PROMPTS` (`1`/`0`) |
| `flushOnCapture` | bool | `false` | `OPENCONTEXT_DSH_FLUSH_ON_CAPTURE` (`1`/`0`) |
| `maxRecallItems` | number | `8` | `OPENCONTEXT_DSH_MAX_RECALL_ITEMS` |
| `autoSummarize` | bool | `false` | `OPENCONTEXT_DSH_AUTO_SUMMARIZE` (`1`/`0`) |
| `captureToolResults` | bool | `false` | `OPENCONTEXT_DSH_CAPTURE_TOOL_RESULTS` (`1`/`0`) |
| `enableInsights` | bool | `true` | `OPENCONTEXT_DSH_ENABLE_INSIGHTS` (`1`/`0`) |
| `enableKnowledge` | bool | `true` | `OPENCONTEXT_DSH_ENABLE_KNOWLEDGE` (`1`/`0`) |

仅作为开关:

- `OPENCONTEXT_DSH_HTTP_URL` — 切到 HTTP 模式(任何非空值)。
  **KOL 制作期间不建议启用。**

## 信任模型

召回块为**主机提供的上下文**,而非指令。块头显式标注其为不可信
的历史证据;若与用户请求冲突,以用户请求为准。该块从不进入
system-prompt 角色,而是作为插件来源的用户消息追加,模型可以在
不影响系统契约的情况下选择忽略。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test          # 108 个单元测试
pnpm build         # tsc → lib/
```

## 架构

```
┌──────────────────────────────────────────────────────────────────────────┐
│                                DSH Agent                                 │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  agent/pre-step pipeline                                           │  │
│  │  ┌───────────────────────────┐    ┌───────────────────────────┐        │  │
│  │  │  Recall                   │    │  Capture                  │        │  │
│  │  │  (search history)         │    │  (store user input)       │        │  │
│  │  └───────────────────────────┘    └───────────────────────────┘        │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                               │                                    │
│                               v                                    │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  turn/end & tool/result listeners                                  │  │
│  │  ┌───────────────────────────┐    ┌───────────────────────────┐        │  │
│  │  │  Session Summ.            │    │  Tool Capture             │        │  │
│  │  │  (session summary)        │    │  (tool output capture)    │        │  │
│  │  └───────────────────────────┘    └───────────────────────────┘        │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                               │                                    │
│                               v                                    │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │                dsh-opencontext plugin (16 tools)                   │  │
│  │  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐          │  │
│  │  │ Core      │ │ Summary   │ │ Insights  │ │ Knowledge │          │  │
│  │  │ (8)       │ │ (3)       │ │ (2)       │ │ (3)       │          │  │
│  │  └───────────┘ └───────────┘ └───────────┘ └───────────┘          │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                               │                                    │
│                               v                                    │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │                         OpenContext Backend                        │  │
│  │  ┌───────────────────────────┐    ┌───────────────────────────┐        │  │
│  │  │  Lib Mode                 │    │  HTTP Mode                │        │  │
│  │  │  (in-process)             │    │  (daemon)                 │        │  │
│  │  └───────────────────────────┘    └───────────────────────────┘        │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

## 许可证

Apache-2.0,见 `LICENSE`。
