# @openloomi/rag

Core Retrieval-Augmented Generation primitives without the AI SDK runtime
overhead. Suitable for lightweight or backend-only consumers that only need
chunking, embeddings, parsers, and a vector store.

## Installation

```sh
pnpm add @openloomi/rag
```

## Subpath Exports

- `@openloomi/rag` — Main entrypoint
- `@openloomi/rag/chunking` — Document chunking strategies
- `@openloomi/rag/embeddings` — Embedding generation helpers
- `@openloomi/rag/vector-service` — High-level vector service facade
- `@openloomi/rag/parsers` — Document parsers (PDF, ZIP, plain text)
- `@openloomi/rag/universal-embeddings` — Universal embedding interface
- `@openloomi/rag/sqlite-vec-store` — sqlite-vec vector store adapter
- `@openloomi/rag/pgvector-store` — pgvector vector store adapter
