/**
 * SQLite-vec Vector Store.
 * Local vector search using the sqlite-vec extension.
 *
 * Compared to PGVectorStore:
 * - No external database service required
 * - Suitable for local desktop applications
 * - Performance slightly lower than PostgreSQL but fully featured
 */

import Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import * as sqliteVec from "sqlite-vec";

export interface VectorSearchResult {
	id: string;
	content: string;
	score: number;
	documentId: string;
	metadata?: Record<string, unknown>;
}

export interface DocumentChunk {
	id: string;
	documentId: string;
	content: string;
	embedding: number[];
	metadata?: Record<string, unknown>;
}

// Loose column type — the host package owns the actual column data type
// (text/varchar/integer/etc.) and we don't want to lock it down here.
type LooseColumn = SQLiteColumn;

// Loose table type — the host package owns the table config and inferred
// row types. We accept any `SQLiteTable` here so this package stays generic
// across different schema definitions.
type LooseTable = SQLiteTable;

export interface SchemaModule {
	ragChunks: LooseTable & {
		id: LooseColumn;
		documentId: LooseColumn;
		userId: LooseColumn;
		content: LooseColumn;
		embedding: LooseColumn;
		metadata: LooseColumn;
		chunkIndex: LooseColumn;
	};
	ragDocuments: LooseTable & {
		id: LooseColumn;
		documentId: LooseColumn;
		userId: LooseColumn;
		fileName: LooseColumn;
	};
	InsertRAGChunk: Record<string, unknown>;
	InsertRAGDocument: Record<string, unknown>;
}

type DrizzleDb = BetterSQLite3Database<Record<string, unknown>>;

/**
 * SQLite Vector Store class.
 */
export class SQLiteVecStore {
	private db: Database.Database;
	private drizzleDb: DrizzleDb | null = null; // Drizzle instance
	private vecTableName: string;
	private initialized = false;
	// Hold onto the host's schema module so async write paths can insert
	// through real Drizzle tables instead of stubbing `{}`. Also keep the
	// lazy-init Promise so callers can `await ensureDrizzle()` before they
	// touch `this.drizzleDb`. Storing the Promise is what makes the
	// constructor safe even though `initDrizzle` is itself `async`.
	private schemaModule: SchemaModule;
	private drizzleReady: Promise<void> | null = null;

	constructor(dbPath: string, schemaModule: SchemaModule) {
		// Open database connection
		this.db = new Database(dbPath);

		// Enable WAL mode
		this.db.pragma("journal_mode = WAL");
		// sqlite-vec exposes a `load` function on the default export.
		sqliteVec.load(this.db);

		// Stash the schema module for later methods (similaritySearch,
		// deleteDocument, etc.) so we don't have to fish it out of `this`.
		this.schemaModule = schemaModule;

		// Kick off the lazy Drizzle init; keep the Promise so write paths
		// can `await` it. The constructor itself stays synchronous, which
		// matches the public type signature `new SQLiteVecStore(...)`.
		this.drizzleReady = this.initDrizzle(schemaModule);

		// User-specific vector table name (using a common name)
		this.vecTableName = "rag_chunks_vec";

		// Initialize vector table
		this.initVectorTable();
	}

	private async initDrizzle(schemaModule: SchemaModule): Promise<void> {
		const { drizzle } = await import("drizzle-orm/better-sqlite3");
		this.drizzleDb = drizzle(this.db, { schema: schemaModule as never });
	}

	/**
	 * Wait for the lazily-initialised Drizzle handle to be ready. The
	 * constructor schedules `initDrizzle` without awaiting it (to keep
	 * the constructor synchronous); every public method that touches
	 * `this.drizzleDb` must call this first.
	 */
	private async ensureDrizzle(): Promise<void> {
		if (this.drizzleReady) {
			await this.drizzleReady;
			this.drizzleReady = null;
		}
	}

	/**
	 * Initialize vector table (using sqlite-vec's vec0 virtual table).
	 */
	private initVectorTable() {
		// Check if table already exists
		const existingTable = this.db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
			.get(this.vecTableName);

		if (!existingTable) {
			// Create vec0 virtual table
			// Embedding vector dimension is 1536 (OpenAI text-embedding-3-small dimension)
			this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS ${this.vecTableName}
          USING vec0(
            embedding float[1536],
            chunk_id TEXT PRIMARY KEY
          )
        `);
		} else {
		}

		this.initialized = true;
	}

	/**
	 * Add document chunk to vector store.
	 */
	async addChunk(chunk: DocumentChunk): Promise<void> {
		// Wait for the lazy Drizzle init kicked off by the constructor
		// before we touch `this.drizzleDb`.
		await this.ensureDrizzle();
		if (!this.drizzleDb) {
			throw new Error("Drizzle initialization did not complete");
		}

		// 1. First insert into rag_chunks table.
		// Resolve the table from the host's schema module — using `{}`
		// here crashes with `Cannot read properties of undefined
		// (reading 'insert')` once Drizzle actually inspects the target.
		const chunkData: Record<string, unknown> = {
			id: chunk.id,
			documentId: chunk.documentId,
			userId: "local", // Fixed user ID for local mode
			chunkIndex: 0, // Can be obtained from metadata
			content: chunk.content,
			embedding: JSON.stringify(chunk.embedding),
			metadata: chunk.metadata ? JSON.stringify(chunk.metadata) : null,
		};

		await this.drizzleDb
			.insert(this.schemaModule.ragChunks as never)
			.values(chunkData)
			.onConflictDoNothing();

		// 2. Insert vector into vec0 table.
		// vec0 virtual tables don't support `ON CONFLICT … DO UPDATE`
		// (sqlite-vec only ships a subset of upsert), so for re-writes
		// we delete any existing row for the same chunk_id first and
		// then insert afresh. On first insert the DELETE matches zero
		// rows, so this is a no-op write path.
		this.db.prepare(`DELETE FROM ${this.vecTableName} WHERE chunk_id = ?`).run(chunk.id);
		const vecStmt = this.db.prepare(`INSERT INTO ${this.vecTableName} (embedding, chunk_id) VALUES (?, ?)`);

		// Convert embedding array to the format required by sqlite-vec
		const embeddingBytes = this.floatArrayToBytes(chunk.embedding);
		vecStmt.run(embeddingBytes, chunk.id);
	}

	/**
	 * Batch add document chunks.
	 */
	async addChunks(chunks: DocumentChunk[]): Promise<void> {
		const insertMany = this.db.transaction(async (chunks: DocumentChunk[]) => {
			for (const chunk of chunks) {
				await this.addChunk(chunk);
			}
		});

		await insertMany(chunks);
	}

	/**
	 * Vector similarity search.
	 * @param queryEmbedding Query vector
	 * @param limit Number of results to return
	 * @param userId Optional user ID filter
	 * @returns List of search results
	 */
	async similaritySearch(
		queryEmbedding: number[],
		limit = 10,
		_userId?: string,
	): Promise<VectorSearchResult[]> {
		if (!this.initialized) {
			throw new Error("Vector store not initialized");
		}

		// Convert query vector to byte array
		const queryBytes = this.floatArrayToBytes(queryEmbedding);

		// Perform vector search
		// Use KNN search algorithm
		const sql = `
        SELECT
          chunk_id,
          distance
        FROM ${this.vecTableName}
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT ?
      `;

		const results = this.db.prepare(sql).all(queryBytes, limit) as Array<{
			chunk_id: string;
			distance: number;
		}>;

		// Get full chunk information
		const chunkIds = results.map((r) => r.chunk_id);

		// Dynamic import of schema-dependent types at call time
		const { eq } = await import("drizzle-orm");
		if (!this.drizzleDb || chunkIds.length === 0) {
			return results.map((result) => ({
				id: result.chunk_id,
				content: "",
				score: 1 - result.distance,
				documentId: "",
				metadata: undefined,
			}));
		}

		const chunks = await this.drizzleDb
			.select()
			.from(this.schemaModule.ragChunks)
			.where(eq(this.schemaModule.ragChunks.id as never, chunkIds[0]));

		// Merge results
		type ChunkRow = { id: string; content?: string; documentId?: string; metadata?: string };
		const finalResults: VectorSearchResult[] = results.map((result) => {
			const chunk = (chunks as ChunkRow[]).find((c) => c.id === result.chunk_id);
			return {
				id: result.chunk_id,
				content: chunk?.content || "",
				score: 1 - result.distance, // Convert distance to similarity score
				documentId: chunk?.documentId || "",
				metadata: chunk?.metadata ? JSON.parse(chunk.metadata) : undefined,
			};
		});

		return finalResults;
	}

	/**
	 * Delete a document and all its chunks.
	 */
	async deleteDocument(documentId: string): Promise<void> {
		if (!this.drizzleDb) return;

		// 1. Get all chunk IDs for the document
		{
			const { eq } = await import("drizzle-orm");
			const chunks = await this.drizzleDb
				.select({ id: this.schemaModule.ragChunks.id as never })
				.from(this.schemaModule.ragChunks)
				.where(eq(this.schemaModule.ragChunks.documentId as never, documentId));

			// 2. Delete from vector table
			const deleteVecStmt = this.db.prepare(`
          DELETE FROM ${this.vecTableName} WHERE chunk_id = ?
        `);

			const deleteVec = this.db.transaction((chunkIds: string[]) => {
				for (const chunkId of chunkIds) {
					deleteVecStmt.run(chunkId);
				}
			});

			type ChunkIdRow = { id: string };
			await deleteVec(chunks.map((c: ChunkIdRow) => c.id));

			// 3. Delete from rag_chunks table
			await this.drizzleDb
				.delete(this.schemaModule.ragChunks)
				.where(eq(this.schemaModule.ragChunks.documentId as never, documentId));

			// 4. Delete from rag_documents table
			await this.drizzleDb
				.delete(this.schemaModule.ragDocuments)
				.where(eq(this.schemaModule.ragDocuments.id as never, documentId));
		}
	}

	/**
	 * Get total document count.
	 */
	async getDocumentCount(): Promise<number> {
		try {
			if (!this.drizzleDb) return 0;

			const result = await this.drizzleDb
				.select({ count: this.schemaModule.ragDocuments.id as never })
				.from(this.schemaModule.ragDocuments);

			return result.length;
		} catch (_error) {
			return 0;
		}
	}

	/**
	 * Get total chunk count.
	 */
	async getChunkCount(): Promise<number> {
		try {
			if (!this.drizzleDb) return 0;

			const result = await this.drizzleDb
				.select({ count: this.schemaModule.ragChunks.id as never })
				.from(this.schemaModule.ragChunks);

			return result.length;
		} catch (_error) {
			return 0;
		}
	}

	/**
	 * Clear all vector data.
	 */
	async clear(): Promise<void> {
		// Delete vector table
		this.db.exec(`DROP TABLE IF EXISTS ${this.vecTableName}`);

		// Delete RAG tables
		if (this.drizzleDb) {
			await this.drizzleDb.delete(this.schemaModule.ragChunks);
			await this.drizzleDb.delete(this.schemaModule.ragDocuments);
		}

		// Re-initialize
		this.initVectorTable();
	}

	/**
	 * Close database connection.
	 */
	close(): void {
		try {
			this.db.close();
		} catch (_error) {}
	}

	/**
	 * Convert float array to byte array format required by sqlite-vec.
	 */
	private floatArrayToBytes(arr: number[]): Buffer {
		const buffer = Buffer.allocUnsafe(arr.length * 4);
		for (let i = 0; i < arr.length; i++) {
			buffer.writeFloatLE(arr[i], i * 4);
		}
		return buffer;
	}

	/**
	 * Convert byte array to float array.
	 */
	private bytesToFloatArray(buffer: Buffer): number[] {
		const arr: number[] = [];
		for (let i = 0; i < buffer.length; i += 4) {
			arr.push(buffer.readFloatLE(i));
		}
		return arr;
	}
}

/**
 * Get SQLiteVecStore instance (singleton pattern).
 */
let vectorStoreInstance: SQLiteVecStore | null = null;

export async function getSQLiteVecStore(dbPath: string, schemaModule: SchemaModule): Promise<SQLiteVecStore> {
	if (!vectorStoreInstance) {
		// The constructor stores `schemaModule` on `this.schemaModule`
		// (and the legacy `_schemaModule` alias used by similaritySearch,
		// deleteDocument, etc.), so no extra wiring is needed here.
		vectorStoreInstance = new SQLiteVecStore(dbPath, schemaModule);
	}
	return vectorStoreInstance;
}

/**
 * Close and reset the vector store instance.
 */
export function resetSQLiteVecStore(): void {
	if (vectorStoreInstance) {
		vectorStoreInstance.close();
		vectorStoreInstance = null;
	}
}
