# indexeddb (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.


Client-side IndexedDB manager for browser storage.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Exports

- `client` - IndexedDB client factory
- `manager` - IndexedDB manager with CRUD operations
- `extractor` - Data extraction utilities

## Peer Dependencies

Requires `react >=18.0.0`.
