/**
 * `@melandlabs/workspace` — schema bootstrap.
 *
 * Workspace tables live in the shared SQLite DB that the memory-store
 * already owns (`~/.opencontext/memory/store.db`), in their own
 * `workspace_*` namespace so they don't collide with `raw_messages` /
 * `facts` / `entities`.
 *
 * The `addColumnIfMissing` helper from `@melandlabs/sqlite/src/schema`
 * is not exported; we replicate the lightweight version here because
 * the workspace tables are created from scratch. When a v2 migration
 * arrives, the same `pragma_table_info`-based detection pattern from
 * the memory schema should be applied — keeping this file's behaviour
 * consistent with `packages/sqlite/src/schema.ts:11-17`.
 */

import type Database from "better-sqlite3";

/**
 * Current schema version. Bump when adding a new table or column;
 * the boot path reads this constant to decide whether to run a
 * migration.
 */
export const WORKSPACE_SCHEMA_VERSION = 1;

/**
 * Idempotent column-add helper for SQLite (which lacks `ADD COLUMN IF NOT
 * EXISTS`). Mirrors `packages/sqlite/src/schema.ts:11-17`.
 */
function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): void {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	if (rows.some((row) => row.name === column)) return;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

/**
 * Run every idempotent DDL statement that backs the workspace
 * feature. Safe to call repeatedly.
 *
 *   - `workspace_resources`              — one row per (workspace, canonical_key)
 *   - `workspace_resource_versions`      — version chain per resource (sha256, parent)
 *   - `workspace_chunks`                  — search-only child chunks per version
 *   - `workspace_chunks_fts`              — FTS5 mirror of `workspace_chunks.content`
 *   - `workspace_reference_edges`         — cites / supersedes / amends / relates-to
 *   - `workspace_jobs`                    — async indexing job status
 *
 * The vec0 child table `workspace_chunks_vec_d1536` is created lazily by
 * `SqliteWorkspaceStore.ensureChildVectorTable(dimensions)` so an empty
 * workspace (no embeddings yet) never wastes disk on an empty vector table.
 */
export function initializeWorkspaceSchema(db: Database.Database): void {
	db.pragma("journal_mode = WAL");
	db.pragma("busy_timeout = 30000");
	db.pragma("foreign_keys = ON");

	db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      canonical_key TEXT NOT NULL,
      title TEXT NOT NULL,
      storage_kind TEXT NOT NULL,
      current_version_id INTEGER,
      index_status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      metadata TEXT,
      UNIQUE(workspace_id, canonical_key)
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_resources_workspace_type
      ON workspace_resources(workspace_id, resource_type);
    CREATE INDEX IF NOT EXISTS idx_workspace_resources_workspace_status
      ON workspace_resources(workspace_id, index_status);
    CREATE INDEX IF NOT EXISTS idx_workspace_resources_user
      ON workspace_resources(user_id);

    CREATE TABLE IF NOT EXISTS workspace_resource_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resource_id INTEGER NOT NULL,
      version_number INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      change_kind TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      parent_version_id INTEGER,
      source_path TEXT,
      created_at INTEGER NOT NULL,
      metadata TEXT,
      UNIQUE(resource_id, version_number)
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_resource_versions_resource
      ON workspace_resource_versions(resource_id, version_number DESC);

    CREATE TABLE IF NOT EXISTS workspace_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id TEXT UNIQUE NOT NULL,
      resource_id INTEGER NOT NULL,
      version_id INTEGER NOT NULL,
      workspace_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL,
      start_position INTEGER NOT NULL,
      end_position INTEGER NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      embedding BLOB,
      embedding_model TEXT,
      embedding_dimensions INTEGER,
      embedding_updated_at INTEGER,
      UNIQUE(resource_id, version_id, chunk_index)
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_chunks_workspace
      ON workspace_chunks(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_workspace_chunks_resource
      ON workspace_chunks(resource_id, version_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS workspace_chunks_fts USING fts5(
      content,
      content='workspace_chunks',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS workspace_chunks_ai AFTER INSERT ON workspace_chunks BEGIN
      INSERT INTO workspace_chunks_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS workspace_chunks_ad AFTER DELETE ON workspace_chunks BEGIN
      INSERT INTO workspace_chunks_fts(workspace_chunks_fts, rowid, content)
      VALUES('delete', old.id, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS workspace_chunks_au AFTER UPDATE ON workspace_chunks BEGIN
      INSERT INTO workspace_chunks_fts(workspace_chunks_fts, rowid, content)
      VALUES('delete', old.id, old.content);
      INSERT INTO workspace_chunks_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TABLE IF NOT EXISTS workspace_reference_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      source_resource_id INTEGER NOT NULL,
      source_version_id INTEGER,
      target_resource_id INTEGER NOT NULL,
      target_version_id INTEGER,
      edge_type TEXT NOT NULL,
      quote TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(workspace_id, source_resource_id, target_resource_id, edge_type)
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_reference_edges_workspace
      ON workspace_reference_edges(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_workspace_reference_edges_source
      ON workspace_reference_edges(source_resource_id);

    CREATE TABLE IF NOT EXISTS workspace_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      total INTEGER NOT NULL DEFAULT 0,
      done INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_jobs_workspace
      ON workspace_jobs(workspace_id, created_at DESC);
  `);

	// Future-proof: keep `addColumnIfMissing` available for v2 migrations
	// without TypeScript flagging it as unused. Same pattern as the
	// memory-store schema's v2–v5 column upgrades.
	void addColumnIfMissing;
}
