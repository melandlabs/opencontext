import type { Connection, FtsOptions, Table } from "@lancedb/lancedb";

import { fuseHybridResults } from "./hybrid-search";
import type {
	DocumentChunk,
	HybridSearchFilter,
	HybridSearchQuery,
	IHybridVectorStore,
	VectorSearchResult,
} from "./vector-service";

type LanceDBModule = typeof import("@lancedb/lancedb");

export interface LanceDBFtsOptions {
	withPosition?: boolean;
	baseTokenizer?:
		| "simple"
		| "whitespace"
		| "raw"
		| "ngram"
		| "icu"
		| "icu/split"
		| `jieba/${string}`
		| `lindera/${string}`;
	language?: string;
	maxTokenLength?: number;
	lowercase?: boolean;
	stem?: boolean;
	removeStopWords?: boolean;
	customStopWords?: string[];
	asciiFolding?: boolean;
	ngramMinLength?: number;
	ngramMaxLength?: number;
	prefixOnly?: boolean;
	blockSize?: 128 | 256;
}

export interface LanceDBStoreOptions {
	/** Local directory, object-store URI, or LanceDB Cloud URI. */
	uri?: string;
	tableName?: string;
	/** Inject an existing connection, primarily for shared connection lifecycle. */
	connection?: object;
	distanceType?: "cosine" | "l2" | "dot";
	fts?: LanceDBFtsOptions;
	createFtsIndex?: boolean;
	defaultFusion?: "rrf" | "weighted";
	defaultAlpha?: number;
	defaultRrfK?: number;
	candidateMultiplier?: number;
}

interface LanceRow {
	[key: string]: unknown;
	id: string;
	document_id: string;
	user_id: string;
	content: string;
	vector: number[];
	metadata: string;
	_distance?: number;
	_score?: number;
	_relevance_score?: number;
}

const DEFAULT_TABLE_NAME = "opencontext_chunks";
const DEFAULT_LIMIT = 10;
const DEFAULT_CANDIDATE_MULTIPLIER = 4;

function assertPositiveInteger(value: number, name: string): void {
	if (!Number.isInteger(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive integer`);
	}
}

function assertEmbedding(embedding: number[], expectedDimension?: number): void {
	if (embedding.length === 0 || embedding.some((value) => !Number.isFinite(value))) {
		throw new TypeError("Embedding must be a non-empty array of finite numbers");
	}
	if (expectedDimension !== undefined && embedding.length !== expectedDimension) {
		throw new RangeError(
			`Embedding dimension ${embedding.length} does not match store dimension ${expectedDimension}`,
		);
	}
}

function assertAlpha(alpha: number): void {
	if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
		throw new RangeError("alpha must be between 0 and 1");
	}
}

function quoteSql(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function buildFilter(filter?: HybridSearchFilter): string | undefined {
	const predicates: string[] = [];
	if (filter?.userId) predicates.push(`user_id = ${quoteSql(filter.userId)}`);
	if (filter?.documentIds?.length) {
		predicates.push(`document_id IN (${filter.documentIds.map(quoteSql).join(", ")})`);
	}
	return predicates.length ? predicates.join(" AND ") : undefined;
}

function metadataUserId(metadata: Record<string, unknown> | undefined): string {
	return typeof metadata?.userId === "string" ? metadata.userId : "";
}

function toLanceRow(chunk: DocumentChunk): LanceRow {
	return {
		id: chunk.id,
		document_id: chunk.documentId,
		user_id: metadataUserId(chunk.metadata),
		content: chunk.content,
		vector: chunk.embedding,
		metadata: JSON.stringify(chunk.metadata ?? {}),
	};
}

function parseMetadata(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Local-first LanceDB vector store with Tantivy BM25 and native RRF support. */
export class LanceDBStore implements IHybridVectorStore {
	private readonly uri?: string;
	private readonly tableName: string;
	private readonly distanceType: "cosine" | "l2" | "dot";
	private readonly fts?: LanceDBFtsOptions;
	private readonly createFtsIndex: boolean;
	private readonly defaultFusion: "rrf" | "weighted";
	private readonly defaultAlpha: number;
	private readonly defaultRrfK: number;
	private readonly candidateMultiplier: number;
	private readonly ownsConnection: boolean;

	private connection?: Connection;
	private table?: Table;
	private dimension?: number;
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(options: LanceDBStoreOptions) {
		if (!options.connection && !options.uri) {
			throw new TypeError("LanceDBStore requires either uri or connection");
		}
		this.uri = options.uri;
		this.connection = options.connection as Connection | undefined;
		this.ownsConnection = !options.connection;
		this.tableName = options.tableName ?? DEFAULT_TABLE_NAME;
		this.distanceType = options.distanceType ?? "cosine";
		this.fts = options.fts;
		this.createFtsIndex = options.createFtsIndex ?? true;
		this.defaultFusion = options.defaultFusion ?? "rrf";
		this.defaultAlpha = options.defaultAlpha ?? 0.5;
		this.defaultRrfK = options.defaultRrfK ?? 60;
		this.candidateMultiplier = options.candidateMultiplier ?? DEFAULT_CANDIDATE_MULTIPLIER;
		assertAlpha(this.defaultAlpha);
		assertPositiveInteger(this.defaultRrfK, "defaultRrfK");
		assertPositiveInteger(this.candidateMultiplier, "candidateMultiplier");
	}

	private async module(): Promise<LanceDBModule> {
		try {
			return await import("@lancedb/lancedb");
		} catch (error) {
			throw new Error("LanceDBStore requires the optional peer dependency @lancedb/lancedb", {
				cause: error,
			});
		}
	}

	private async getConnection(): Promise<Connection> {
		if (this.connection) return this.connection;
		const lance = await this.module();
		this.connection = await lance.connect(this.uri as string);
		return this.connection;
	}

	private async ensureFtsIndex(table: Table): Promise<void> {
		if (!this.createFtsIndex) return;
		const indices = await table.listIndices();
		if (indices.some((index) => index.columns.includes("content") && index.indexType === "FTS")) return;
		const lance = await this.module();
		await table.createIndex("content", {
			config: lance.Index.fts(this.fts as Partial<FtsOptions>),
			replace: false,
		});
	}

	private async readDimension(table: Table): Promise<void> {
		const schema = await table.schema();
		const vectorField = schema.fields.find((field) => field.name === "vector");
		const listSize = (vectorField?.type as { listSize?: unknown } | undefined)?.listSize;
		if (typeof listSize === "number" && Number.isInteger(listSize) && listSize > 0) {
			this.dimension = listSize;
		}
	}

	private async openExistingTable(): Promise<Table | undefined> {
		if (this.table) return this.table;
		const connection = await this.getConnection();
		const tableNames = await connection.tableNames();
		if (!tableNames.includes(this.tableName)) return undefined;
		this.table = await connection.openTable(this.tableName);
		await this.readDimension(this.table);
		await this.ensureFtsIndex(this.table);
		return this.table;
	}

	private async getOrCreateTable(rows: LanceRow[]): Promise<{ table: Table; created: boolean }> {
		const existing = await this.openExistingTable();
		if (existing) return { table: existing, created: false };
		const connection = await this.getConnection();
		this.table = await connection.createTable(this.tableName, rows);
		await this.ensureFtsIndex(this.table);
		return { table: this.table, created: true };
	}

	private enqueueWrite(operation: () => Promise<void>): Promise<void> {
		const result = this.writeQueue.then(operation, operation);
		this.writeQueue = result.catch(() => undefined);
		return result;
	}

	async addChunk(chunk: DocumentChunk): Promise<void> {
		await this.addChunks([chunk]);
	}

	async addChunks(chunks: DocumentChunk[]): Promise<void> {
		if (chunks.length === 0) return;
		const dimension = this.dimension ?? chunks[0].embedding.length;
		for (const chunk of chunks) assertEmbedding(chunk.embedding, dimension);
		const rows = chunks.map(toLanceRow);

		await this.enqueueWrite(async () => {
			const { table, created } = await this.getOrCreateTable(rows);
			this.dimension = dimension;
			if (created) return;
			await table.mergeInsert(["id"]).whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(rows);
		});
	}

	private denseScore(row: LanceRow): number {
		const distance = typeof row._distance === "number" ? row._distance : Number.POSITIVE_INFINITY;
		if (!Number.isFinite(distance)) return 0;
		return this.distanceType === "cosine" ? 1 - distance : 1 / (1 + Math.max(0, distance));
	}

	private rowToResult(row: LanceRow, mode: "dense" | "lexical" | "hybrid"): VectorSearchResult {
		const score =
			mode === "dense"
				? this.denseScore(row)
				: mode === "lexical"
					? (row._score ?? 0)
					: (row._relevance_score ?? row._score ?? this.denseScore(row));
		return {
			id: String(row.id),
			documentId: String(row.document_id),
			content: String(row.content),
			score,
			metadata: parseMetadata(row.metadata),
		};
	}

	async similaritySearch(
		queryEmbedding: number[],
		limit = DEFAULT_LIMIT,
		userId?: string,
	): Promise<VectorSearchResult[]> {
		assertEmbedding(queryEmbedding, this.dimension);
		assertPositiveInteger(limit, "limit");
		await this.writeQueue;
		const table = await this.openExistingTable();
		if (!table) return [];
		assertEmbedding(queryEmbedding, this.dimension);

		let search = table.query().nearestTo(queryEmbedding).distanceType(this.distanceType).limit(limit);
		const filter = buildFilter(userId ? { userId } : undefined);
		if (filter) search = search.where(filter);
		const rows = (await search.toArray()) as LanceRow[];
		return rows.map((row) => this.rowToResult(row, "dense"));
	}

	async hybridSearch(query: HybridSearchQuery): Promise<VectorSearchResult[]> {
		const limit = query.limit ?? DEFAULT_LIMIT;
		assertPositiveInteger(limit, "limit");
		const candidateLimit = query.candidateLimit ?? limit * this.candidateMultiplier;
		assertPositiveInteger(candidateLimit, "candidateLimit");
		const text = query.text.trim();
		if (!text && !query.vector?.length) return [];
		if (query.vector) assertEmbedding(query.vector, this.dimension);

		await this.writeQueue;
		const table = await this.openExistingTable();
		if (!table) return [];
		if (query.vector) assertEmbedding(query.vector, this.dimension);
		const predicate = buildFilter(query.filter);

		if (!query.vector?.length) {
			let lexicalQuery = table.query().fullTextSearch(text, { columns: "content" }).limit(limit);
			if (predicate) lexicalQuery = lexicalQuery.where(predicate);
			const rows = (await lexicalQuery.toArray()) as LanceRow[];
			return rows.map((row) => this.rowToResult(row, "lexical"));
		}

		if (!text) {
			let denseQuery = table.query().nearestTo(query.vector).distanceType(this.distanceType).limit(limit);
			if (predicate) denseQuery = denseQuery.where(predicate);
			const rows = (await denseQuery.toArray()) as LanceRow[];
			return rows.map((row) => this.rowToResult(row, "dense"));
		}

		const strategy = query.fusion ?? this.defaultFusion;
		if (strategy === "rrf") {
			const rrfK = query.rrfK ?? this.defaultRrfK;
			assertPositiveInteger(rrfK, "rrfK");
			const lance = await this.module();
			const reranker = await lance.rerankers.RRFReranker.create(rrfK);
			let hybridQuery = table
				.query()
				.nearestTo(query.vector)
				.distanceType(this.distanceType)
				.fullTextSearch(text, { columns: "content" })
				.limit(candidateLimit)
				.rerank(reranker);
			if (predicate) hybridQuery = hybridQuery.where(predicate);
			const rows = (await hybridQuery.toArray()) as LanceRow[];
			return rows.slice(0, limit).map((row) => this.rowToResult(row, "hybrid"));
		}

		const alpha = query.alpha ?? this.defaultAlpha;
		assertAlpha(alpha);
		let denseQuery = table
			.query()
			.nearestTo(query.vector)
			.distanceType(this.distanceType)
			.limit(candidateLimit);
		let lexicalQuery = table.query().fullTextSearch(text, { columns: "content" }).limit(candidateLimit);
		if (predicate) {
			denseQuery = denseQuery.where(predicate);
			lexicalQuery = lexicalQuery.where(predicate);
		}
		const [denseRows, lexicalRows] = (await Promise.all([denseQuery.toArray(), lexicalQuery.toArray()])) as [
			LanceRow[],
			LanceRow[],
		];

		return fuseHybridResults({
			dense: denseRows.map((row) => this.rowToResult(row, "dense")),
			lexical: lexicalRows.map((row) => this.rowToResult(row, "lexical")),
			strategy: "weighted",
			alpha,
			limit,
		});
	}

	async deleteDocument(documentId: string): Promise<void> {
		await this.enqueueWrite(async () => {
			const table = await this.openExistingTable();
			if (table) await table.delete(`document_id = ${quoteSql(documentId)}`);
		});
	}

	async getDocumentCount(): Promise<number> {
		await this.writeQueue;
		const table = await this.openExistingTable();
		if (!table) return 0;
		const rows = (await table.query().select(["document_id"]).toArray()) as Array<{
			document_id: string;
		}>;
		return new Set(rows.map((row) => row.document_id)).size;
	}

	async getChunkCount(): Promise<number> {
		await this.writeQueue;
		const table = await this.openExistingTable();
		return table ? table.countRows() : 0;
	}

	async clear(): Promise<void> {
		await this.enqueueWrite(async () => {
			const connection = await this.getConnection();
			if ((await connection.tableNames()).includes(this.tableName)) {
				await connection.dropTable(this.tableName);
			}
			this.table = undefined;
			this.dimension = undefined;
		});
	}

	async close(): Promise<void> {
		await this.writeQueue;
		if (this.ownsConnection && this.connection) this.connection.close();
		this.connection = undefined;
		this.table = undefined;
	}
}
