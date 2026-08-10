# @melandlabs/opencontext

The single-package facade for the OpenContext runtime.

A host application installs **one** package and gets every capability:
the contracts layer, the four-verb memory API, unified search, RAG
primitives, the loop engine, and the agent runtime.

```bash
pnpm add @melandlabs/opencontext
```

```ts
import { createMemoryStore } from "@melandlabs/opencontext";

const store = await createMemoryStore({
	db: { type: "sqlite-vec", path: "./memory.db" },
	vector: { provider: "openai", model: "text-embedding-3-small" },
});

await store.raw.remember({
	content: "User prefers dark mode in all tools",
	scope: "user:42",
});
```

## What's inside

A host application installs one package and gets every capability —
contracts, memory, unified search, RAG, loop, and agent runtime — behind
a single `import { … } from "@melandlabs/opencontext"` boundary.

| Concern             | Re-exported symbol                |
| ------------------- | --------------------------------- |
| Boundary types      | `USER_TYPES`, `isUserType`, …     |
| Memory + search     | `createMemoryStore`, …            |
| Unified search      | `createUnifiedSearch`, …          |
| Chunking / RAG      | `chunkText`, `SQLiteVecStore`, …  |
| Loop engine         | `readPreferences`, `writePreferences`, … |
| Agent runtime       | `getModelPricing`, `calculateTotalCredits`, … |

The internal workspace packages (`contracts`, `memory-store`, `rag`,
`loop`, `ai`, …) are bundled into the published artifact at build
time. The published manifest declares no internal-package runtime
dependencies — only third-party packages (`hono`, `zod`,
`better-sqlite3`, …) that consumers receive transitively when they
install `@melandlabs/opencontext`.

## Underlying workspace

The full monorepo (with each package independently versioned and
publishable) lives at
[github.com/melandlabs/opencontext](https://github.com/melandlabs/opencontext).
This facade is the recommended install for consumers; the underlying
workspace packages exist for advanced users who want granular control.

## License

Apache-2.0. © 2026 Meland Labs.