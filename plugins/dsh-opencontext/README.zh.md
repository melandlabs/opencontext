# dsh-opencontext

为 DeepSeek Harness (DSH) agent 提供持久化记忆与检索增强上下文的插件,
基于 [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)。

- **包名**:`dsh-opencontext`
- **协议**:Apache-2.0
- **Node 版本**:`^22.19.0 || >=24.0.0`
- **工具前缀**:`oc_*`
- **技能**:`opencontext-context`
- **命令**:`/oc doctor`

## 安装

```bash
# 1. 构建插件(生成 lib/)
pnpm install
pnpm build

# 2. 注册到 DSH profile
dsh plugin --profile web add /path/to/dsh-opencontext

# 3. 确认已挂载
dsh --profile web --dump-config
#   ... 应包含 `id: dsh-opencontext`
```

## 功能

### 工具(8 个)

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

### 技能:`opencontext-context`

在 `apply` 时注册。让模型在每次会话开始时即了解召回/捕获约定、
信任模型与 8 个 `oc_*` 工具的语义。

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
  "recentCount": 0
}
```

## 两种后端模式

### `lib`(默认)

进程内模式,直接调用 `@melandlabs/opencontext`。SQLite 文件路径默认
为 `~/.opencontext/memory/store.db`,可通过 `MEMORY_STORE_DB_PATH` 环境
变量覆盖(由 opencontext 读取)。

### `http`(可选)

设置 `OPENCONTEXT_DSH_HTTP_URL` 时启用。请求路径对齐上游
`powercontext-dsh` 插件使用的 `/v1/memory/*` 与 `/v1/context/*`。
当前 v0.1.x OpenContext daemon 尚未暴露这些端点,因此 HTTP 模式
属于前瞻设计;day-one 推荐使用 `lib` 模式。

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

仅作为开关:

- `OPENCONTEXT_DSH_HTTP_URL` — 切到 HTTP 模式(任何非空值)。

## 信任模型

召回块为**主机提供的上下文**,而非指令。块头显式标注其为不可信
的历史证据;若与用户请求冲突,以用户请求为准。该块从不进入
system-prompt 角色,而是作为插件来源的用户消息追加,模型可以在
不影响系统契约的情况下选择忽略。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test          # 59 个单元测试
pnpm build         # tsc → lib/
```

## 许可证

Apache-2.0,见 `LICENSE`。
