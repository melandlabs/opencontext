# @opencontext/sqlite

SQLite-backed persistence layer for OpenContext. Wraps `better-sqlite3` with
the `sqlite-vec` extension and exposes the raw message store plus the shared
schema definitions.

## Installation

```sh
pnpm add @opencontext/sqlite
```

## Subpath Exports

- `@opencontext/sqlite` — High-level helpers and the SQLite connection factory
- `@opencontext/sqlite/raw-message-manager` — CRUD operations for raw chat
  messages (used by sync pipelines)
- `@opencontext/sqlite/schema` — Shared schema definitions and migrations

## Peer Dependencies

- `better-sqlite3` and `sqlite-vec` (installed as regular dependencies)
