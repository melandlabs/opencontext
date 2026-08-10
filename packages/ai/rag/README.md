# @openloomi/ai-rag

Retrieval-Augmented Generation (RAG) primitives for OpenLoomi. Provides
text chunking, embedding adapters (local Transformers, OpenAI, ChromaDB),
document parsers (PDF, ZIP, etc.), and pluggable vector stores
(sqlite-vec, pgvector, ChromaDB).

## Installation

```sh
pnpm add @openloomi/ai-rag
```

## Subpath Exports

- `@openloomi/ai-rag` — Main entrypoint
- `@openloomi/ai-rag/chunking` — Document chunking strategies
- `@openloomi/ai-rag/embeddings` — Embedding generation helpers
- `@openloomi/ai-rag/vector-service` — High-level vector service facade
- `@openloomi/ai-rag/unified-vector-search-service` — Unified search service
- `@openloomi/ai-rag/parsers` — Document parsers (PDF, ZIP, plain text)
- `@openloomi/ai-rag/embedding-provider` — Embedding provider interface
- `@openloomi/ai-rag/local-transformers-embedding-provider` — Local
  HuggingFace Transformers-based embedding provider
- `@openloomi/ai-rag/universal-embeddings` — Universal embedding interface
- `@openloomi/ai-rag/chroma-store` — ChromaDB vector store adapter
- `@openloomi/ai-rag/sqlite-vec-store` — sqlite-vec vector store adapter
- `@openloomi/ai-rag/pgvector-store` — pgvector vector store adapter
