# sqlite (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.


SQLite-backed persistence layer for OpenContext. Wraps `better-sqlite3` with
the `sqlite-vec` extension and exposes the raw message store plus the shared
schema definitions.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Subpath Exports

- `sqlite` — High-level helpers and the SQLite connection factory
- `sqlite/raw-message-manager` — CRUD operations for raw chat
  messages (used by sync pipelines)
- `sqlite/schema` — Shared schema definitions and migrations

## Peer Dependencies

- `better-sqlite3` and `sqlite-vec` (installed as regular dependencies)
