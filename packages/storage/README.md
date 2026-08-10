# storage (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.

Storage abstraction with first-class adapters for the local filesystem and
[Vercel Blob](https://vercel.com/docs/storage/vercel-blob). Lets the rest of
the OpenContext stack stay agnostic of where bytes actually live.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Subpath Exports

- `storage` — Default local filesystem provider
- `storage/provider` — Provider interface
- `storage/local` — Local filesystem implementation
- `storage/memory` — In-memory implementation (testing)
- `storage/adapters` — Re-export of all adapters
- `storage/adapters/local-fs` — Local filesystem adapter
- `storage/adapters/vercel-blob` — Vercel Blob adapter

## Peer Dependencies

None. `@vercel/blob` is bundled as a regular dependency for the Vercel Blob
adapter.
