---
"@melandlabs/workspace": minor
---

新增 `@melandlabs/workspace/core` 入口：后端无关的那一面，不含任何原生模块。

根入口（`@melandlabs/workspace`）re-export 了 SQLite store，而 SQLite store 在
import 时就加载 `better-sqlite3`——所以从根入口 import 任何东西，都会把原生模块
拖进 bundle。打包器没法把一个被 re-export 的原生模块 tree-shake 掉，于是"服务端不
带 better-sqlite3"这件事只能靠根本不碰它来实现。

`core` 就是那个"根本不碰"：OKF 遍历、文本抽取、embedding provider、混合检索融合、
store 契约与编排层都在里面，模块图里没有 `better-sqlite3` / `sqlite-vec`。服务端
（Vercel Function）这类只跑 Postgres 后端、从不碰本地文件的部署，从这里 import 就
够了。

不包含的内容：SQLite store 本身（见 `@melandlabs/workspace/sqlite`）与同步→异步的
适配器 `SqliteWorkspaceStoreAdapter` / `toWorkspaceStore`（它们的存在就是为了适配
那个 store）。

新增 `test/core-entry.test.ts`：遍历构建产物的模块图，断言 `core` 与 `postgres` 两个
入口都不含原生模块——检查源码不够，要检查真正发布出去的那份图。
