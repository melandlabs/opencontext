# @openloomi/storage

Storage abstraction with first-class adapters for the local filesystem and
[Vercel Blob](https://vercel.com/docs/storage/vercel-blob). Lets the rest of
the OpenLoomi stack stay agnostic of where bytes actually live.

## Installation

```sh
pnpm add @openloomi/storage
```

## Subpath Exports

- `@openloomi/storage` — Default local filesystem provider
- `@openloomi/storage/provider` — Provider interface
- `@openloomi/storage/local` — Local filesystem implementation
- `@openloomi/storage/memory` — In-memory implementation (testing)
- `@openloomi/storage/adapters` — Re-export of all adapters
- `@openloomi/storage/adapters/local-fs` — Local filesystem adapter
- `@openloomi/storage/adapters/vercel-blob` — Vercel Blob adapter

## Peer Dependencies

None. `@vercel/blob` is bundled as a regular dependency for the Vercel Blob
adapter.
