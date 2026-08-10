# ai-rag (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.


Retrieval-Augmented Generation (RAG) primitives for OpenContext. Provides
text chunking, embedding adapters (local Transformers, OpenAI, ChromaDB),
document parsers (PDF, ZIP, etc.), and pluggable vector stores
(sqlite-vec, pgvector, ChromaDB).

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Subpath Exports

- `ai-rag` — Main entrypoint
- `ai-rag/chunking` — Document chunking strategies
- `ai-rag/embeddings` — Embedding generation helpers
- `ai-rag/vector-service` — High-level vector service facade
- `ai-rag/unified-vector-search-service` — Unified search service
- `ai-rag/parsers` — Document parsers (PDF, ZIP, plain text)
- `ai-rag/embedding-provider` — Embedding provider interface
- `ai-rag/local-transformers-embedding-provider` — Local
  HuggingFace Transformers-based embedding provider
- `ai-rag/universal-embeddings` — Universal embedding interface
- `ai-rag/chroma-store` — ChromaDB vector store adapter
- `ai-rag/sqlite-vec-store` — sqlite-vec vector store adapter
- `ai-rag/pgvector-store` — pgvector vector store adapter
