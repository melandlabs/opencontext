/**
 * SQLite-backed VSA fact store.
 *
 * Implements the `VsaFactStorage` contract from `@melandlabs/contracts`.
 * Vectors are stored as Float32 BLOBs via the shared `floatArrayToBuffer` /
 * `bufferToFloatArray` helpers so they round-trip byte-for-byte.
 *
 * Schema lives in `initializeRawMessageSchema` (the same `init` path used by
 * `SQLiteRawMessageManager`). The `vsa_facts` table is created idempotently
 * with `CREATE TABLE IF NOT EXISTS`, so callers don't need a separate
 * migration step — opening the manager is enough.
 */

import type { VsaFact, VsaFactStorage } from "@melandlabs/contracts";
import Database from "better-sqlite3";
import { bufferToFloatArray, floatArrayToBuffer } from "./raw-message-manager";

type DatabaseLike = Database.Database;

export interface SQLiteVsaStoreOptions {
	dbPath?: string;
	db?: DatabaseLike;
}

export class SQLiteVsaStore implements VsaFactStorage {
	private readonly db: DatabaseLike;
	// Exposed for test introspection only — production callers should use
	// the `VsaFactStorage` contract methods (`storeFact`, `queryFacts`,
	// `deprecateFacts`) instead of touching the raw better-sqlite3 handle.
	readonly __testDb: DatabaseLike;
	private readonly ownsConnection: boolean;

	constructor(options: SQLiteVsaStoreOptions | string = ":memory:") {
		if (typeof options === "string") {
			this.db = new Database(options);
			this.__testDb = this.db;
			this.ownsConnection = true;
			return;
		}

		if (options.db) {
			this.db = options.db;
			this.__testDb = this.db;
			this.ownsConnection = false;
			return;
		}

		this.db = new Database(options.dbPath ?? ":memory:");
		this.__testDb = this.db;
		this.ownsConnection = true;
	}

	async init(): Promise<void> {
		// Schema initialization is owned by `SQLiteRawMessageManager.init()`
		// because it uses the same DB connection. If a host constructs a
		// `SQLiteVsaStore` against its own DB, we still need the table to
		// exist — call into the shared initializer.
		const { initializeRawMessageSchema } = await import("./schema");
		initializeRawMessageSchema(this.db);
	}

	async close(): Promise<void> {
		if (this.ownsConnection) {
			this.db.close();
		}
	}

	async storeFact(fact: VsaFact): Promise<void> {
		if (!fact.factId) {
			throw new Error("SQLiteVsaStore.storeFact: factId is required");
		}
		if (!fact.userId) {
			throw new Error("SQLiteVsaStore.storeFact: userId is required");
		}
		if (!fact.roleLabel) {
			throw new Error("SQLiteVsaStore.storeFact: roleLabel is required");
		}
		if (!fact.fillerLabel) {
			throw new Error("SQLiteVsaStore.storeFact: fillerLabel is required");
		}
		if (!Number.isInteger(fact.dim) || fact.dim <= 0) {
			throw new Error(`SQLiteVsaStore.storeFact: dim must be a positive integer, got ${fact.dim}`);
		}
		if (fact.roleVector.length !== fact.dim) {
			throw new Error(
				`SQLiteVsaStore.storeFact: roleVector.length (${fact.roleVector.length}) must equal dim (${fact.dim})`,
			);
		}
		if (fact.fillerVector.length !== fact.dim) {
			throw new Error(
				`SQLiteVsaStore.storeFact: fillerVector.length (${fact.fillerVector.length}) must equal dim (${fact.dim})`,
			);
		}

		const scopeTag = fact.scopeTag ?? "default";

		const stmt = this.db.prepare(`
			INSERT INTO vsa_facts (
				fact_id, user_id, scope_tag, bot_id,
				role_label, filler_label,
				role_vector, filler_vector, dim,
				created_at, deprecated_at, deprecation_reason
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(fact_id) DO UPDATE SET
				user_id = excluded.user_id,
				scope_tag = excluded.scope_tag,
				bot_id = excluded.bot_id,
				role_label = excluded.role_label,
				filler_label = excluded.filler_label,
				role_vector = excluded.role_vector,
				filler_vector = excluded.filler_vector,
				dim = excluded.dim,
				deprecated_at = NULL,
				deprecation_reason = NULL
		`);

		stmt.run(
			fact.factId,
			fact.userId,
			scopeTag,
			fact.botId ?? null,
			fact.roleLabel,
			fact.fillerLabel,
			floatArrayToBuffer(fact.roleVector),
			floatArrayToBuffer(fact.fillerVector),
			fact.dim,
			fact.createdAt,
			null,
			null,
		);
	}

	async queryFacts(input: {
		userId: string;
		scopeTag?: string;
		botId?: string;
		includeDeprecated?: boolean;
		limit?: number;
	}): Promise<VsaFact[]> {
		const where: string[] = ["user_id = ?"];
		const params: Array<string | number> = [input.userId];

		if (input.scopeTag) {
			where.push("scope_tag = ?");
			params.push(input.scopeTag);
		}
		if (input.botId) {
			where.push("bot_id = ?");
			params.push(input.botId);
		}
		if (!input.includeDeprecated) {
			where.push("deprecated_at IS NULL");
		}

		const limit = input.limit && input.limit > 0 ? Math.floor(input.limit) : 1000;

		const sql = `
			SELECT fact_id, user_id, scope_tag, bot_id,
			       role_label, filler_label,
			       role_vector, filler_vector, dim,
			       created_at, deprecated_at, deprecation_reason
			FROM vsa_facts
			WHERE ${where.join(" AND ")}
			ORDER BY created_at ASC
			LIMIT ${limit}
		`;

		const rows = this.db.prepare(sql).all(...params) as Array<{
			fact_id: string;
			user_id: string;
			scope_tag: string;
			bot_id: string | null;
			role_label: string;
			filler_label: string;
			role_vector: Buffer;
			filler_vector: Buffer;
			dim: number;
			created_at: number;
			deprecated_at: number | null;
			deprecation_reason: string | null;
		}>;

		return rows.map((row) => ({
			factId: row.fact_id,
			userId: row.user_id,
			scopeTag: row.scope_tag,
			botId: row.bot_id ?? undefined,
			roleLabel: row.role_label,
			fillerLabel: row.filler_label,
			roleVector: bufferToFloatArray(row.role_vector) ?? [],
			fillerVector: bufferToFloatArray(row.filler_vector) ?? [],
			dim: row.dim,
			createdAt: row.created_at,
			deprecatedAt: row.deprecated_at ?? undefined,
			deprecationReason: row.deprecation_reason ?? undefined,
		}));
	}

	async deprecateFacts(input: {
		userId: string;
		factIds: string[];
		reason?: string;
		now?: number;
	}): Promise<{ deprecatedCount: number }> {
		if (input.factIds.length === 0) {
			return { deprecatedCount: 0 };
		}
		const now = input.now ?? Date.now();
		const placeholders = input.factIds.map(() => "?").join(", ");
		const stmt = this.db.prepare(`
			UPDATE vsa_facts
			SET deprecated_at = ?, deprecation_reason = ?
			WHERE user_id = ?
			  AND fact_id IN (${placeholders})
			  AND deprecated_at IS NULL
		`);
		const result = stmt.run(now, input.reason ?? null, input.userId, ...input.factIds);
		return { deprecatedCount: result.changes };
	}
}

let singleton: SQLiteVsaStore | null = null;

/**
 * Singleton accessor. The caller must resolve the DB path itself
 * (typically via `resolveSQLiteRawMessageDbPath` from
 * `@melandlabs/memory-store/sqlite-raw-message-store`); we can't import
 * that helper here because `memory-store` already depends on
 * `@melandlabs/sqlite` and a back-edge would form a cycle. Hosts that
 * need a separate VSA DB can construct `SQLiteVsaStore` directly.
 */
export async function getSQLiteVsaStore(options: { dbPath: string }): Promise<SQLiteVsaStore> {
	if (!singleton) {
		if (!options.dbPath) {
			throw new Error("getSQLiteVsaStore: dbPath is required");
		}
		singleton = new SQLiteVsaStore({ dbPath: options.dbPath });
		await singleton.init();
	}
	return singleton;
}

export async function closeSQLiteVsaStore(): Promise<void> {
	if (!singleton) return;
	await singleton.close();
	singleton = null;
}

export function __resetSQLiteVsaStoreForTests(): void {
	singleton = null;
}
