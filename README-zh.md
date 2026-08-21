<div align="center">

# OpenContext

**Agentic 上下文运行时底座，让应用真正能自主行动**

一个时序上下文图谱、一套记忆 API、检索原语,
和一个多平台集成网格，设计上可被嵌入到任何宿主进程或 agent。

<p align="center">
<a href="./README.md">English</a> · <a href="./README-zh.md">简体中文</a>
</p>

[![License](https://img.shields.io/badge/License-Apache_2.0-F8D52A?logo=apache)](./LICENSE)
[![npm version](https://img.shields.io/npm/v/@melandlabs/opencontext.svg)](https://www.npmjs.com/package/@melandlabs/opencontext)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.com/invite/xkJaJyWcsv)
[![X](https://img.shields.io/badge/X-Follow-000000?logo=x&logoColor=white)](https://x.com/OpenContextAI)

</div>

<div align="center">

⭐ **如果你觉得 opencontext 有用,欢迎在 GitHub 上给我们点一颗 star!** 这能帮助更多人发现这个项目,也激励我们持续投入。🙏

[![GitHub Repo stars](https://img.shields.io/github/stars/melandlabs/opencontext?style=social&label=Star)](https://github.com/melandlabs/opencontext)

</div>

---

## OpenContext 是什么?

**OpenContext** 是位于 Agentic 应用下方的 Agentic 上下文运行时 —— 也是你拿来"构建自己的 agent"的运行时底座。它不是 UI、不是聊天界面、也不是模型提供商,而是把让 agent 真正有用的那些东西(持久化的记忆、检索、上下文修正、多平台连接、周期性的感知与 Loop 循环)合在同一个依赖里的胶水。

→ 阅读 [`docs/architecture.md`](./docs/architecture.md) 了解完整的数据模型、事实的生命周期,以及传输面映射。

## 谁适合用?

OpenContext 适合**需要把"上下文"工程化**的团队 —— 也就是日常工作正好踩在下面这几类问题上的人。每条都说清楚"为什么"和"怎么解决",方便对号入座:

- **软件工程团队** —— 决策散落在 GitHub PR、Linear ticket、Slack thread、Notion doc 里,跨人、跨工具、跨季度。新人问"为什么当初选了 X"找不到出处。OpenContext 的时序图把每条事实带 `valid_from / valid_until` 存下来,跨季度也能准确回答"我们当时是怎么想的",而不是只能拿到最近一次印象。
- **效率工程 / 内部自动化团队** —— 给团队或公司做工具的人。要的不是又一套 SaaS,而是一个能塞进 CLI / MCP server / 守护进程的运行时。OpenContext 是 library-first,确定性 Loop 引擎只在确实有事时才调 LLM,不会变成一个一直烧 token 的常驻循环。
- **办公助手类产品** —— 跑在 Telegram、iMessage、WhatsApp、Lark/Feishu 等多种即时通讯上的助手,要求同一份 agent 代码、同一份上下文。`IntegrationRecord` 统一屏蔽凭据、限流、重连;`platform + messageId` 是天然的审计轨迹,适合处理私聊与工作内容这种敏感数据。
- **金融交易团队** —— 每次下单、调仓、风控触发都需要溯源、可审计。时序图 + append-only 修正让"四月的策略是什么"成为可查的事实,而不是被覆盖的猜测;留痕与回溯天然对齐 MiFID II / SEC 等监管要求。
- **法务、医疗等强审计场景** —— 律所、医院这类团队,每个判断都需要逐条事实来源、append-only 修正记录、可导出的合规证据。
- **多 Agent 与自动化工作流作者** —— 需要确定性的、可调度的唤醒,而不是一路贯穿的 LLM 循环;`packages/loop` 直接提供这种分离式调度器。

## 特性

|     | 能力                                                                    | 它做什么                                                                                                                                           |
| --- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🧠  | **[时序上下文图谱](./docs/architecture.md#the-temporal-context-graph)** | 每条事实都带有 `valid_from` / `valid_until` 的有向无环图。取代、矛盾与合并是一等边 —— 修正以 append-only 方式进行,不会破坏性覆写。                 |
| 🔌  | **[平台集成网格](./packages/integrations)**                             | Gmail、Slack、Telegram、Linear、Jira、iMessage、Feishu、Weixin……统一的 `IntegrationRecord` 形态,凭据轮换、限流处理与重连逻辑都被封装在适配器背后。 |
| ⏰  | **[确定性 Loop 引擎](./packages/loop)**                                 | 一个会先醒来、判断是否存在真实工作,然后才会调用 `@melandlabs/opencontext` 的调度器。LLM 调用不是底座，而是最后一步。                               |
| 🔍  | **[检索原语](./packages/rag)**                                          | 分块、嵌入、解析器(PDF / ZIP / text)、sqlite-vec + pgvector + Chroma 适配器。可混用后端而无需重写召回流水线。                                      |
| 🤖  | **[Agent 运行时](./packages/ai)**                                       | AI SDK 包装、沙箱提供商(原生 / Claude / Vercel)、MCP server、memory-consolidation 任务、图像与音频生成。                                           |
| 🪶  | **[单包门面](./packages/opencontext)**                                  | `pnpm add @melandlabs/opencontext` 一行装下整个运行时底座。不强依赖 React、Next 或 Tauri。                                                         |
| 🛡️  | **[审计与加密存储](./packages/audit)**                                  | 结构化审计日志写入 `~/.opencontext/logs/audit.jsonl`,使用 Fernet 对称加密保护密钥,出站调用使用 URL 白/黑名单管控。                                 |

## 基准测试

第三方记忆与长上下文召回基准测试结果(数据截至 2026-08):

| 基准测试      | 得分   | 说明                                              |
| ------------- | ------ | ------------------------------------------------- |
| LongMemEval-S | 97.6%  | 长会话下的长期记忆召回                            |
| LoCoMo-V2     | 97.4%  | 长多模态对话中的问答                              |
| BEAM @ 10M    | 67.0%  | 10M token 上下文窗口下的事实召回                  |

## 快速开始

有四种方式把 opencontext 接入你的项目。根据你正在构建的东西任选其一。

### 1. 把运行时嵌入到自己的应用

```bash
pnpm add @melandlabs/opencontext
```

记忆 API 的 30 秒示例:

```ts
import { createMemoryStore, getRawMessageManager } from "@melandlabs/opencontext";

// 存储默认走 SQLite，路径由 MEMORY_STORE_DB_PATH 决定（默认 ./memory.db）。
// 每次调用都会返回 awaitable 句柄。
const store = await createMemoryStore();
const messages = await getRawMessageManager();

// 一条消息就是一条事实：归属于某个用户的单段内容。
// `messageId` 让重复摄取天然幂等。
const now = Date.now();
await messages.storeMessages([
	{
		messageId: "msg-1",
		userId: "u-42",
		content: "User prefers dark mode in all tools",
		platform: "test",
		botId: "bot-1",
		timestamp: now,
		createdAt: now,
	},
]);

// 统一搜索会向 memory + insights + knowledge 三个来源扇出。
// 未配置的来源只会发一条 warning —— 单后端部署完全没问题。
const hits = await store.search({
	userId: "u-42",
	query: "What does the user prefer?",
	limit: 5,
});
// hits.count    — 结果条数
// hits.sources  — 真正被查询过的子索引
// hits.warnings — 各来源的降级信息（例如缺少 embedder）
```

### 2. 从源码构建本 monorepo

```bash
git clone https://github.com/melandlabs/opencontext.git
cd opencontext
pnpm install
pnpm -r build
```

### 3. 通过 npm 启动 HTTP daemon

```bash
# `pnpm add -g @melandlabs/opencontext` 后,bin 已在 PATH 上:
opencontext http \
  --embedding-provider local \
  --memory-backend sqlite-vec \
  --host 127.0.0.1 --port 7421
# 或者不全局安装,直接用 npx:
npx -y @melandlabs/opencontext http \
  --embedding-provider local --memory-backend sqlite-vec
curl http://127.0.0.1:7421/health
```

### 4. 把 MCP server 接入 Claude Desktop / Cursor

```bash
opencontext mcp \
  --embedding-provider local \
  --memory-backend sqlite-vec
```

### 5. 在 DeepSeek Harness (DSH) 中使用

OpenContext 可作为 DSH 插件使用，为任何 DSH agent 提供持久记忆和检索增强上下文：

```bash
# 从 npm 安装插件
dsh plugin --profile web add dsh-opencontext

# 确认已挂载
dsh --profile web --dump-config | grep dsh-opencontext
#   ... 应包含 `id: dsh-opencontext`

# 启动 DSH web 并验证
dsh web
#   访问 http://127.0.0.1:3080/plugins，确认 dsh-opencontext 显示 "Enabled"
```

插件会暴露 16 个 `oc_*` 工具（如 `oc_search`、`oc_remember`、`oc_memory_list`），并自动：
- 每轮对话运行 recall 瀑布流，注入相关历史上下文
- 将用户消息捕获到持久记忆中
- 在自然断点处进行会话总结（可选）

配置选项和完整工具参考见 [`plugins/dsh-opencontext/README.md`](./plugins/dsh-opencontext/README.md)。

### 6. 诊断安装环境

```bash
opencontext doctor             # 人类可读的健康检查
opencontext doctor --json      # 适配 CI 的 { ok, exit, results } 输出
opencontext doctor --section memory-store
```

`doctor` 是只读命令,健康时退出码为 `0`。它会扫描九个区块
(`runtime`、`filesystem`、`loop`、`memory-store`、`embedding`、
`policies`、`audit`、`security`、`integrations`) 并对每项报告
pass / warn / fail。v1 不支持自动修复。

**下一步：** [教程](./docs/tutorials/README.md) — 快速入门、用户指南、开发者指南、高级用法和最佳实践

## 示例

[`examples/`](./examples/) 这个目录按能力域给每个 API 都配了一份可运行的示例。
clone 下来直接跑:

```bash
git clone https://github.com/melandlabs/opencontext.git
cd opencontext/examples
pnpm install
pnpm test
```

完整说明见 [`examples/README.md`](./examples/README.md)。

## 它有什么不同

OpenContext 既不是记忆库,也不是向量数据库。它是一个运行时底座 —— 每个包独立版本化、单一职责,并且在边界层只消费 `@melandlabs/opencontext`。

| 对比对象                                         | opencontext 多出来的能力                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 一个扁平的向量数据库(Pinecone、Weaviate、Qdrant) | **时序图** —— 事实带有 `valid_from` / `valid_until`,会被取代,而不仅仅是按相似度匹配              |
| 一个上下文 / 记忆库                              | **运行时而非库** —— HTTP daemon、MCP server、CLI,以及集成网格与 Loop 引擎                        |
| 自己接一套 agent 循环                            | **可分离的 Loop 引擎** —— 调度何时调用 `@melandlabs/opencontext`,而不是一路贯穿到底都是 LLM 循环 |
| 为了使用集成而必须嵌入整个 opencontext           | **Library-First API 面** —— 每个包都可独立发布,使用任意一个都不要求 React / Next / Tauri         |

## 架构

```
                       ┌────────────────────────────┐
                       │     宿主应用                │   ← 你的 UI、CLI 或 daemon
                       │   (参考应用                 │
                       │    或你自己的 embedder)      │
                       └─────────────┬──────────────┘
                                     │
            ┌────────────────────────┴────────────────────────┐
            │   边界层: @melandlabs/opencontext  ·  api        │
            └────────────────────────┬────────────────────────┘
                                     │
       ┌─────────────────────────────┴─────────────────────────────┐
       │   记忆底座                                                 │
       │   @melandlabs/opencontext · rag · sqlite · indexeddb      │
       └─────────────────────────────┬────────────────────────────-┘
                                     │
       ┌─────────────────────────────┴─────────────────────────────┐
       │   引擎        @melandlabs/opencontext · cron · insights    │
       │   Agent 运行时 @melandlabs/opencontext                     │
       │   集成          @melandlabs/opencontext                    │
       └───────────────────────────────────────────────────────────┘
```

完整的数据流图、传输面与存储后端见
[`docs/architecture.md`](./docs/architecture.md)。

## 真实使用

- **[OpenContext](https://github.com/melandlabs/opencontext)** —— 构建在
  这套运行时之上的跨平台桌面 "Attention Agent"。读
  [仓库 README](https://github.com/melandlabs/opencontext) 看同一套
  原语如何被接成一个真实产品。

## 文档

### 教程（从这里开始）

- [`docs/tutorials/README.md`](./docs/tutorials/README.md) — **教程目录和学习路径**
- [`docs/tutorials/00-getting-started.md`](./docs/tutorials/00-getting-started.md) — 5 分钟快速上手
- [`docs/tutorials/01-user-guide.md`](./docs/tutorials/01-user-guide.md) — 理解四个动词和时间记忆
- [`docs/tutorials/02-developer-guide.md`](./docs/tutorials/02-developer-guide.md) — 将 OpenContext 集成到你的应用
- [`docs/tutorials/03-advanced-usage.md`](./docs/tutorials/03-advanced-usage.md) — 生产模式与高级功能
- [`docs/tutorials/04-best-practices.md`](./docs/tutorials/04-best-practices.md) — 最佳实践和常见陷阱
- [`docs/tutorials/use-cases/README.md`](./docs/tutorials/use-cases/README.md) — 真实场景用例：个人记忆助手、客服 agent、研究追踪

### 架构与设计

- [`docs/architecture.md`](./docs/architecture.md) — 数据模型、生命周期、数据面和控制面
- [`docs/philosophy.md`](./docs/philosophy.md) — 为什么是这种形态
- 每个包的 `README.md` — API 面、示例、迁移说明

## 贡献

参见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。

## 许可证

[Apache-2.0](./LICENSE)。© 2026 Meland Labs。
