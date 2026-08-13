<div align="center">

# OpenContext

**驱动 Agentic 应用的上下文运行时底座**

一个时序上下文图谱、一套记忆 API、检索原语,
和一个多平台集成网格，设计上可被嵌入到任何宿主进程。

<p align="center">
<a href="./README.md">English</a> · <a href="./README-zh.md">简体中文</a>
</p>

[![License](https://img.shields.io/badge/License-Apache_2.0-F8D52A?logo=apache)](./LICENSE)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.com/invite/xkJaJyWcsv)
[![X](https://img.shields.io/badge/X-Follow-000000?logo=x&logoColor=white)](https://x.com/AlloomiAI)

</div>

<div align="center">

⭐ **如果你觉得 opencontext 有用,欢迎在 GitHub 上给我们点一颗 star!** 这能帮助更多人发现这个项目,也激励我们持续投入。🙏

[![GitHub Repo stars](https://img.shields.io/github/stars/melandlabs/opencontext?style=social&label=Star)](https://github.com/melandlabs/opencontext)

</div>

---

## OpenContext 是什么?

**OpenContext** 是位于 Agentic 应用下方的上下文运行时层 —— 也是你拿来"构建自己的 agent"的运行时底座。它不是 UI、不是聊天界面、也不是模型提供商,而是把让 agent 真正有用的那些东西(持久化的记忆、检索、上下文修正、多平台连接、周期性的感知与 Loop 循环)合在同一个依赖里的胶水。

→ 阅读 [`docs/architecture.md`](./docs/architecture.md) 了解完整的数据模型、事实的生命周期,以及传输面映射。

## 谁适合用?

OpenContext 适合**需要把"上下文"工程化**的团队 —— 也就是日常工作正好踩在下面这几类问题上的人。每条都说清楚"为什么"和"怎么解决",方便对号入座:

- **软件工程团队** —— 决策散落在 GitHub PR、Linear ticket、Slack thread、Notion doc 里,跨人、跨工具、跨季度。新人问"为什么当初选了 X"找不到出处。OpenContext 的时序图把每条事实带 `valid_from / valid_until` 存下来,跨季度也能准确回答"我们当时是怎么想的",而不是只能拿到最近一次印象。
- **效率工程 / 内部自动化团队** —— 给团队或公司做工具的人。要的不是又一套 SaaS,而是一个能塞进 CLI / MCP server / 守护进程的运行时。OpenContext 是 library-first,确定性 Loop 引擎只在确实有事时才调 LLM,不会变成一个一直烧 token 的常驻循环。
- **办公助手类产品** —— 跑在 Telegram、iMessage、WhatsApp、Lark/Feishu 等多种即时通讯上的助手,要求同一份 agent 代码、同一份上下文。`IntegrationRecord` 统一屏蔽凭据、限流、重连;`platform + messageId` 是天然的审计轨迹,适合处理私聊与工作内容这种敏感数据。
- **金融交易团队** —— 每次下单、调仓、风控触发都需要溯源、可审计。时序图 + append-only 修正让"四月的策略是什么"成为可查的事实,而不是被覆盖的猜测;留痕与回溯天然对齐 MiFID II / SEC 等监管要求。
- **法务、医疗等强审计场景** —— 律所、医院这类团队,每个判断都需要逐条事实来源、append-only 修正记录、可导出的合规证据。
- **多 agent 与自动化工作流作者** —— 需要确定性的、可调度的唤醒,而不是一路贯穿的 LLM 循环;`packages/loop` 直接提供这种分离式调度器。
- **Agent / LLM 平台团队** —— 想把记忆、检索、集成装进产品背后同一个运行时,而不是各自再重写一遍。
- **开源 AI 建设者** —— 想以 OpenContext 为底座**构建自己的 agent**,而不是自己拼凑一堆厂商组件:把记忆、检索、集成、Loop 引擎都跑在同一个 Apache-2.0、可自托管的运行时上。

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
const hits = await store.searchUnifiedMemory({
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

## 常用使用模式

### 记忆 API

`@melandlabs/opencontext` 暴露两个工厂调用加上一个扁平、小巧的搜索面。写入走 raw message manager,并天然按 `messageId` 幂等；读取会向 memory + insights + knowledge 扇出,未配置的来源优雅降级。完整的配置矩阵与示例见 [`packages/memory-store/README.md`](./packages/memory-store/README.md)。

| 符号                              | 用途                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `createMemoryStore(config?)`      | 引导存储。返回 `{ raw, search, getRawMessageManager, searchUnifiedMemory, … }`。                  |
| `getRawMessageManager()`          | 拿到当前生效的 raw message manager（默认 SQLite，注册后端后切换 Postgres）。                       |
| `manager.storeMessages(messages)` | 摄取事实。按 `messageId` 幂等。每行承载完整的 `RawMessage` 形态。                                |
| `store.searchUnifiedMemory(opts)` | 在 memory + insights + knowledge 上的统一搜索,未配置的来源只发 warning。                          |

### 时序查询(时间旅行)

上下文图中每条事实都带 `valid_from` 与 `valid_until`,因此某个时间点的查询等价于"其有效区间覆盖了 `t` 的事实"。统一搜索 API 本身并未直接暴露时间点过滤 —— 时序访问住在更下一层,在 `@melandlabs/ai/memory-consolidation`(`graph-aware-query`)与 `@melandlabs/indexeddb/memory-graph-evolution` 里。as-of 查询请直接参考这两个包。

### MCP server

`@melandlabs/opencontext/mcp` 通过 stdio 暴露相同的操作 —— 可被 Claude Desktop、Cursor、Claude Code、Codex CLI 或任何具备 MCP 能力的 agent 运行时直接使用。

### 跨源搜索

`createUnifiedSearch(deps)` 允许你为每个来源独立接入搜索器。你省略的来源只会打印一条 warning —— 对只读部署或单后端栈来说完全没问题:

```ts
import { createUnifiedSearch } from "@melandlabs/opencontext";

const search = createUnifiedSearch({
	embedQuery: myEmbedder.embedQuery,
	searchRawMessagesAnn: pgAnnSearch,
	searchInsights: insightIndex.search,
	searchKnowledge: ragIndex.search,
});

const { results, warnings } = await search.searchUnifiedMemory({
	userId: "u-1",
	query: "what changed since yesterday?",
	sources: ["memory", "insights", "knowledge"],
	limit: 10,
});
```

### 后端选型

每个后端在启动时通过 `MemoryStoreConfig` 选择 —— 没有抽象会隐藏每个后端能做到什么。支持混用后端:比如可以把 raw message 存放在 Postgres,同时把 Chroma 用作向量索引。

| 关注点     | 后端                                                                                 |
| ---------- | ------------------------------------------------------------------------------------ |
| Raw 消息   | SQLite-vec(默认,本地文件)、Postgres(服务端 / daemon,通过工厂注册)、IndexedDB(浏览器) |
| 向量索引   | SQLite-vec(默认)、pgvector、Chroma、IndexedDB                                        |
| Embeddings | OpenAI、Anthropic、Cohere,通过 `@melandlabs/opencontext/universal-embeddings` 走本地 |

## 它有什么不同

OpenContext 既不是记忆库,也不是向量数据库。它是一个运行时底座 —— 每个包独立版本化、单一职责,并且在边界层只消费 `@melandlabs/opencontext`。

| 对比对象                                         | opencontext 多出来的能力                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 一个扁平的向量数据库(Pinecone、Weaviate、Qdrant) | **时序图** —— 事实带有 `valid_from` / `valid_until`,会被取代,而不仅仅是按相似度匹配              |
| 一个上下文 / 记忆库                              | **运行时而非库** —— HTTP daemon、MCP server、CLI,以及集成网格与 Loop 引擎                        |
| 自己接一套 agent 循环                            | **可分离的 Loop 引擎** —— 调度何时调用 `@melandlabs/opencontext`,而不是一路贯穿到底都是 LLM 循环 |
| 为了使用集成而必须嵌入整个 opencontext           | **Library-First API 面** —— 每个包都可独立发布,使用任意一个都不要求 React / Next / Tauri         |

## Provider 矩阵

| 关注点       | 提供方                                                                                                                                                                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 向量索引     | SQLite-vec(默认)、pgvector、Chroma、IndexedDB(浏览器)                                                                                                                                                                                                |
| Embeddings   | OpenAI、Anthropic、Cohere,通过 `@melandlabs/opencontext/universal-embeddings` 走本地                                                                                                                                                                 |
| Raw 消息存储 | SQLite-vec、Postgres                                                                                                                                                                                                                                 |
| Web 搜索     | Brave Search                                                                                                                                                                                                                                         |
| 沙箱         | Native CLI、Claude、Vercel Sandbox                                                                                                                                                                                                                   |
| TTS / STT    | Kokoro(TTS)、Whisper(STT)                                                                                                                                                                                                                            |
| 集成         | Gmail、Outlook、Google Calendar、Google Meet、Slack、Discord、Teams、Telegram、WhatsApp、LinkedIn、Instagram、X、Facebook Messenger、HubSpot、Notion、Asana、Jira、Linear、iMessage、Feishu、Dingtalk、QQbot、Weixin、RSS、Google Drive、Google Docs |

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

- **[OpenLoomi](https://github.com/melandlabs/openloomi)** —— 构建在
  OpenContext 之上的跨平台桌面 "Attention Agent"。读
  [OpenLoomi README](https://github.com/melandlabs/openloomi) 看同一套
  原语如何被接成一个真实产品。

## 文档

- [`docs/architecture.md`](./docs/architecture.md) — 数据模型、生命周期、数据面和控制面
- [`docs/philosophy.md`](./docs/philosophy.md) — 为什么是这种形态
- 每个包的 `README.md` — API 面、示例、迁移说明

## 贡献

参见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。

## 许可证

[Apache-2.0](./LICENSE)。© 2026 Meland Labs。
