# @opencontext/storage

Storage abstraction with first-class adapters for the local filesystem and
[Vercel Blob](https://vercel.com/docs/storage/vercel-blob). Lets the rest of
the OpenContext stack stay agnostic of where bytes actually live.

## Installation

```sh
pnpm add @opencontext/storage
```

## Subpath Exports

- `@opencontext/storage` — Default local filesystem provider
- `@opencontext/storage/provider` — Provider interface
- `@opencontext/storage/local` — Local filesystem implementation
- `@opencontext/storage/memory` — In-memory implementation (testing)
- `@opencontext/storage/adapters` — Re-export of all adapters
- `@opencontext/storage/adapters/local-fs` — Local filesystem adapter
- `@opencontext/storage/adapters/vercel-blob` — Vercel Blob adapter

## Peer Dependencies

None. `@vercel/blob` is bundled as a regular dependency for the Vercel Blob
adapter.
