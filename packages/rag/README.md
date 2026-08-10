# @opencontext/rag

Core Retrieval-Augmented Generation primitives without the AI SDK runtime
overhead. Suitable for lightweight or backend-only consumers that only need
chunking, embeddings, parsers, and a vector store.

## Installation

```sh
pnpm add @opencontext/rag
```

## Subpath Exports

- `@opencontext/rag` — Main entrypoint
- `@opencontext/rag/chunking` — Document chunking strategies
- `@opencontext/rag/embeddings` — Embedding generation helpers
- `@opencontext/rag/vector-service` — High-level vector service facade
- `@opencontext/rag/parsers` — Document parsers (PDF, ZIP, plain text)
- `@opencontext/rag/universal-embeddings` — Universal embedding interface
- `@opencontext/rag/sqlite-vec-store` — sqlite-vec vector store adapter
- `@opencontext/rag/pgvector-store` — pgvector vector store adapter
