# @openloomi/sqlite

SQLite-backed persistence layer for OpenLoomi. Wraps `better-sqlite3` with
the `sqlite-vec` extension and exposes the raw message store plus the shared
schema definitions.

## Installation

```sh
pnpm add @openloomi/sqlite
```

## Subpath Exports

- `@openloomi/sqlite` — High-level helpers and the SQLite connection factory
- `@openloomi/sqlite/raw-message-manager` — CRUD operations for raw chat
  messages (used by sync pipelines)
- `@openloomi/sqlite/schema` — Shared schema definitions and migrations

## Peer Dependencies

- `better-sqlite3` and `sqlite-vec` (installed as regular dependencies)
