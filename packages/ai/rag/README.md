# @opencontext/ai-rag

Retrieval-Augmented Generation (RAG) primitives for OpenLoomi. Provides
text chunking, embedding adapters (local Transformers, OpenAI, ChromaDB),
document parsers (PDF, ZIP, etc.), and pluggable vector stores
(sqlite-vec, pgvector, ChromaDB).

## Installation

```sh
pnpm add @opencontext/ai-rag
```

## Subpath Exports

- `@opencontext/ai-rag` — Main entrypoint
- `@opencontext/ai-rag/chunking` — Document chunking strategies
- `@opencontext/ai-rag/embeddings` — Embedding generation helpers
- `@opencontext/ai-rag/vector-service` — High-level vector service facade
- `@opencontext/ai-rag/unified-vector-search-service` — Unified search service
- `@opencontext/ai-rag/parsers` — Document parsers (PDF, ZIP, plain text)
- `@opencontext/ai-rag/embedding-provider` — Embedding provider interface
- `@opencontext/ai-rag/local-transformers-embedding-provider` — Local
  HuggingFace Transformers-based embedding provider
- `@opencontext/ai-rag/universal-embeddings` — Universal embedding interface
- `@opencontext/ai-rag/chroma-store` — ChromaDB vector store adapter
- `@opencontext/ai-rag/sqlite-vec-store` — sqlite-vec vector store adapter
- `@opencontext/ai-rag/pgvector-store` — pgvector vector store adapter
