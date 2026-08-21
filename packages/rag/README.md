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
- `rag/lancedb-store` — embedded/local LanceDB hybrid store
- `rag/milvus-store` — external Milvus hybrid store
- `rag/hybrid-search` — fusion adapter for an existing vector and lexical store

## Hybrid retrieval

LanceDB and Milvus implement dense vector retrieval plus BM25/full-text
retrieval. Reciprocal Rank Fusion (RRF) is the default because the two branches
use different score scales; weighted, min-max-normalized fusion is also
available.

Install only the backend used by the host application:

```sh
pnpm add @lancedb/lancedb
# or
pnpm add @zilliz/milvus2-sdk-node
```

Configure LanceDB for an embedded/local deployment:

```ts
import {
  configureVectorService,
  searchHybridVectorStore,
} from "@melandlabs/opencontext";

configureVectorService({
  backend: "lancedb",
  lancedb: { uri: "./data/lancedb" },
  hybrid: { fusion: "rrf", candidateMultiplier: 4 },
});

const matches = await searchHybridVectorStore({
  text: "invoice-2024-017",
  vector: queryEmbedding,
  limit: 10,
  filter: { userId },
});
```

For a Milvus 2.5+ service, configure the server address and the embedding
dimension. The adapter creates one collection containing a dense vector and a
BM25-generated sparse vector:

```ts
configureVectorService({
  backend: "milvus",
  milvus: {
    address: "localhost:19530",
    dimension: 1536,
  },
  hybrid: { fusion: "weighted", alpha: 0.65 },
});
```

Existing sqlite-vec, pgvector, and custom factories remain valid. The hybrid
helper falls back to their existing dense `similaritySearch` implementation,
so enabling the new adapters does not require migrating existing data. Use
`HybridSearchAdapter` when the application already has a separate lexical
search provider and wants to add fusion without changing its vector store.
