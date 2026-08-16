/**
 * Lib-mode knowledge store.
 *
 * Gives the dsh-opencontext plugin document upload + RAG search without
 * requiring a separate OpenContext HTTP daemon. It lives inside the DSH
 * process and stores:
 *
 *   - document metadata in a SQLite table
 *   - document chunks in a SQLite table
 *   - chunk embeddings in a sqlite-vec `vec0` virtual table
 *
 * Embeddings come from the local ONNX embedder
 * (`LocalTransformersEmbeddingProvider`, re-exported by
 * `@melandlabs/opencontext`). Chunking uses the facade's `chunkText`.
 *
 * If `@melandlabs/ai-rag` is not resolvable at runtime (it is a peer of
 * the facade), the store gracefully reports itself as unavailable and
 * the backend falls back to the same structured errors HTTP mode would
 * return.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Buffer } from "node:buffer";

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

export interface KnowledgeChunk {
	id: string;
	content: string;
	documentId: string;
	documentName: string;
	score: number;
	chunkIndex: number;
	metadata?: Record<string, unknown>;
}

export interface KnowledgeDocument {
	id: string;
	filename: string;
	mimeType: string;
	uploadedAt: number;
	chunks: number;
	metadata?: Record<string, unknown>;
}

export interface UploadDocumentInput {
	content: string;
	filename: string;
	mimeType: string;
	metadata?: Record<string, unknown>;
	scopeId: string;
	userId: string;
}

export interface SearchKnowledgeInput {
	query: string;
	documentIds?: string[];
	limit: number;
	threshold: number;
	scopeId: string;
	userId: string;
}

export interface ListDocumentsInput {
	limit: number;
	scopeId: string;
	userId: string;
}

interface LocalEmbeddingProvider {
	getDimensions(): number | undefined;
	embedDocuments(texts: string[]): Promise<number[][]>;
	embedQuery(text: string): Promise<number[]>;
}

interface TextChunkLike {
	content: string;
	index?: number;
}

const KNOWLEDGE_DIR_NAME = ".opencontext";
const KNOWLEDGE_DB_NAME = "dsh-knowledge.db";
const DEFAULT_VEC_DIMENSION = 384; // Xenova/all-MiniLM-L6-v2

export interface KnowledgeStoreOptions {
	dbPath?: string;
	provider?: LocalEmbeddingProvider | null;
}

export class LibKnowledgeStore {
	private dbPath: string;
	private db: Database.Database | null = null;
	private provider: LocalEmbeddingProvider | null = null;
	private providerPromise: Promise<LocalEmbeddingProvider | null> | null = null;
	private autoProviderDisabled = false;
	private vecDimension = DEFAULT_VEC_DIMENSION;
	private closed = false;

	constructor(options?: KnowledgeStoreOptions) {
		this.dbPath = options?.dbPath ?? join(homedir(), KNOWLEDGE_DIR_NAME, KNOWLEDGE_DB_NAME);
		if (options && "provider" in options) {
			this.provider = options.provider ?? null;
			this.autoProviderDisabled = options.provider === null;
		}
	}

	async uploadDocument(input: UploadDocumentInput): Promise<{ documentId: string; chunks: number }> {
		const provider = await this.ensureProvider();
		if (!provider) {
			throw new KnowledgeUnavailableError("local embedding provider is not available");
		}

		this.ensureDb();

		const documentId = makeDocumentId(input.content, input.filename, input.scopeId, input.userId);
		const chunks = await chunkDocument(input.content);
		if (chunks.length === 0) {
			return { documentId, chunks: 0 };
		}

		const texts = chunks.map((c) => c.content);
		const embeddings = await provider.embedDocuments(texts);
		if (embeddings.length !== chunks.length) {
			throw new Error(`embedding count mismatch: expected ${chunks.length}, got ${embeddings.length}`);
		}

		const dim = embeddings[0]?.length ?? provider.getDimensions() ?? DEFAULT_VEC_DIMENSION;
		this.vecDimension = dim;
		this.ensureVectorTable(dim);

		const now = Date.now();
		this.db!.prepare(
			`INSERT OR REPLACE INTO documents
			 (id, scopeId, userId, filename, mimeType, uploadedAt, chunkCount, metadata)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			documentId,
			input.scopeId,
			input.userId,
			input.filename,
			input.mimeType,
			now,
			chunks.length,
			JSON.stringify(input.metadata ?? {}),
		);

		const insertChunk = this.db!.prepare(
			`INSERT OR REPLACE INTO chunks
			 (id, documentId, chunkIndex, content, metadata)
			 VALUES (?, ?, ?, ?, ?)`,
		);
		const insertVec = this.db!.prepare(
			`INSERT OR REPLACE INTO ${this.vecTableName(dim)} (embedding, chunk_id) VALUES (?, ?)`,
		);

		const insertAll = this.db!.transaction((items: Array<{ chunk: TextChunk; embedding: number[] }>) => {
			for (const { chunk, embedding } of items) {
				const chunkId = `${documentId}_chunk_${chunk.index}`;
				insertChunk.run(chunkId, documentId, chunk.index, chunk.content, JSON.stringify({}));
				insertVec.run(this.floatArrayToBytes(embedding), chunkId);
			}
		});

		insertAll(chunks.map((chunk, i) => ({ chunk, embedding: embeddings[i]! })));

		return { documentId, chunks: chunks.length };
	}

	async searchKnowledge(input: SearchKnowledgeInput): Promise<{ chunks: KnowledgeChunk[] }> {
		const provider = await this.ensureProvider();
		if (!provider) {
			return { chunks: [] };
		}

		this.ensureDb();

		const dim = provider.getDimensions() ?? this.vecDimension;
		this.ensureVectorTable(dim);

		const queryEmbedding = await provider.embedQuery(input.query);
		const queryBytes = this.floatArrayToBytes(queryEmbedding);

		const limit = Math.max(1, input.limit);
		const vecTable = this.vecTableName(dim);

		let vecRows: Array<{ chunk_id: string; distance: number }> = [];
		try {
			vecRows = this.db!.prepare(
				`SELECT chunk_id, distance FROM ${vecTable} WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
			).all(queryBytes, limit) as Array<{ chunk_id: string; distance: number }>;
		} catch {
			return { chunks: [] };
		}

		if (vecRows.length === 0) {
			return { chunks: [] };
		}

		const chunkIds = vecRows.map((r) => r.chunk_id);
		const placeholders = chunkIds.map(() => "?").join(",");
		const rows = this.db!.prepare(
			`SELECT c.id, c.documentId, c.chunkIndex, c.content, d.filename, c.metadata
				 FROM chunks c
				 JOIN documents d ON d.id = c.documentId
				 WHERE c.id IN (${placeholders})
				   AND d.scopeId = ? AND d.userId = ?`,
		).all(...chunkIds, input.scopeId, input.userId) as Array<{
			id: string;
			documentId: string;
			chunkIndex: number;
			content: string;
			filename: string;
			metadata: string;
		}>;

		const rowById = new Map(rows.map((r) => [r.id, r]));
		const chunks: KnowledgeChunk[] = [];
		for (const vecRow of vecRows) {
			const row = rowById.get(vecRow.chunk_id);
			if (!row) continue;
			if (input.documentIds && input.documentIds.length > 0 && !input.documentIds.includes(row.documentId)) {
				continue;
			}
			const score = 1 - vecRow.distance;
			if (score < input.threshold) continue;
			chunks.push({
				id: row.id,
				content: row.content,
				documentId: row.documentId,
				documentName: row.filename,
				score,
				chunkIndex: row.chunkIndex,
				metadata: parseJson(row.metadata),
			});
		}

		return { chunks };
	}

	async listDocuments(input: ListDocumentsInput): Promise<{ documents: KnowledgeDocument[] }> {
		this.ensureDb();

		const rows = this.db!.prepare(
			`SELECT id, filename, mimeType, uploadedAt, chunkCount, metadata
				 FROM documents
				 WHERE scopeId = ? AND userId = ?
				 ORDER BY uploadedAt DESC
				 LIMIT ?`,
		).all(input.scopeId, input.userId, input.limit) as Array<{
			id: string;
			filename: string;
			mimeType: string;
			uploadedAt: number;
			chunkCount: number;
			metadata: string;
		}>;

		return {
			documents: rows.map((r) => ({
				id: r.id,
				filename: r.filename,
				mimeType: r.mimeType,
				uploadedAt: r.uploadedAt,
				chunks: r.chunkCount,
				metadata: parseJson(r.metadata),
			})),
		};
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.db?.close();
		} catch {
			// ignore
		}
		this.db = null;
	}

	private ensureDb(): void {
		if (this.db) return;
		ensureDirSync(dirname(this.dbPath));
		const db = new Database(this.dbPath);
		db.pragma("journal_mode = WAL");
		try {
			(sqliteVec as any).load(db);
		} catch (error) {
			db.close();
			throw new KnowledgeUnavailableError(`failed to load sqlite-vec extension: ${(error as Error).message}`);
		}

		db.exec(`
			CREATE TABLE IF NOT EXISTS documents (
				id TEXT PRIMARY KEY,
				scopeId TEXT NOT NULL,
				userId TEXT NOT NULL,
				filename TEXT NOT NULL,
				mimeType TEXT NOT NULL,
				uploadedAt INTEGER NOT NULL,
				chunkCount INTEGER NOT NULL DEFAULT 0,
				metadata TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_documents_scope ON documents(scopeId, userId);

			CREATE TABLE IF NOT EXISTS chunks (
				id TEXT PRIMARY KEY,
				documentId TEXT NOT NULL,
				chunkIndex INTEGER NOT NULL,
				content TEXT NOT NULL,
				metadata TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(documentId);
		`);

		this.db = db;
	}

	private ensureVectorTable(dim: number): void {
		if (!this.db) return;
		const tableName = this.vecTableName(dim);
		const exists = this.db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
			.get(tableName);
		if (exists) return;

		this.db.exec(
			`CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName} USING vec0(embedding float[${dim}], chunk_id TEXT PRIMARY KEY)`,
		);
	}

	private vecTableName(dim: number): string {
		return `knowledge_vec_${dim}`;
	}

	private async ensureProvider(): Promise<LocalEmbeddingProvider | null> {
		if (this.provider) return this.provider;
		if (this.autoProviderDisabled) return null;
		if (this.providerPromise) return this.providerPromise;

		this.providerPromise = (async () => {
			try {
				const mod = await import("@melandlabs/opencontext");
				const LocalProvider = (
					mod as unknown as { LocalTransformersEmbeddingProvider?: new () => LocalEmbeddingProvider }
				).LocalTransformersEmbeddingProvider;
				if (typeof LocalProvider === "function") {
					return new LocalProvider();
				}
			} catch {
				// optional peer not available
			}
			return null;
		})();

		this.provider = await this.providerPromise;
		return this.provider;
	}

	private floatArrayToBytes(arr: number[]): Buffer {
		const buffer = Buffer.allocUnsafe(arr.length * 4);
		for (let i = 0; i < arr.length; i++) {
			buffer.writeFloatLE(arr[i]!, i * 4);
		}
		return buffer;
	}
}

export class KnowledgeUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "KnowledgeUnavailableError";
	}
}

function makeDocumentId(content: string, filename: string, scopeId: string, userId: string): string {
	const hash = createHash("sha256")
		.update(`${userId}:${scopeId}:${filename}:${content.slice(0, 4096)}`)
		.digest("hex");
	return `doc-${hash.slice(0, 24)}`;
}

interface TextChunk {
	content: string;
	index: number;
}

async function chunkDocument(content: string): Promise<TextChunk[]> {
	if (!content.trim()) return [];
	try {
		const mod = await import("@melandlabs/opencontext");
		const chunkTextFn = (mod as unknown as { chunkText?: (text: string, opts?: unknown) => TextChunkLike[] })
			.chunkText;
		if (typeof chunkTextFn === "function") {
			const raw = chunkTextFn(content, { maxChunkSize: 800, chunkOverlap: 100 });
			return raw.map((c, i) => ({ content: c.content, index: c.index ?? i }));
		}
	} catch {
		// Fall through to simple splitter if the facade is not resolvable.
	}
	return simpleChunk(content, 800, 100);
}

function simpleChunk(text: string, size: number, overlap: number): TextChunk[] {
	const chunks: TextChunk[] = [];
	let start = 0;
	let index = 0;
	while (start < text.length) {
		const end = Math.min(start + size, text.length);
		chunks.push({ content: text.slice(start, end).trim(), index });
		if (end === text.length) break;
		start = end - overlap;
		index++;
	}
	return chunks;
}

function parseJson(raw: string | null | undefined): Record<string, unknown> | undefined {
	if (!raw) return undefined;
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function ensureDirSync(dir: string): void {
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		// ignore
	}
}
