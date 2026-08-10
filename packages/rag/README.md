# rag (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.

Core Retrieval-Augmented Generation primitives without the AI SDK runtime
overhead. Suitable for lightweight or backend-only consumers that only need
chunking, embeddings, parsers, and a vector store.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Subpath Exports

- `rag` — Main entrypoint
- `rag/chunking` — Document chunking strategies
- `rag/embeddings` — Embedding generation helpers
- `rag/vector-service` — High-level vector service facade
- `rag/parsers` — Document parsers (PDF, ZIP, plain text)
- `rag/universal-embeddings` — Universal embedding interface
- `rag/sqlite-vec-store` — sqlite-vec vector store adapter
- `rag/pgvector-store` — pgvector vector store adapter
