import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import {
	MEMORY_SUMMARY_OWNER_SCOPE_CONFLICT,
	MEMORY_SUMMARY_WRITE_CONFLICT,
	hasMemorySummaryPublicationRevisionConflict,
	isMemorySummaryPublicationPendingRecord,
	mergeStoredChatMemoryEvidence,
	withoutMemorySummaryPublicationExpectedRevision,
} from "../../indexeddb/src/storage";
import type {
	MemoryStage,
	MemorySummaryQuery,
	MemorySummaryRecord,
	RawMessage,
	RawMessageEmbeddingUpdate,
	RawMessageQuery,
	RawMessageSearchChunk,
	RawMessageSearchIndexStats,
	RawMessageStats,
	RawMessageStorageManager,
} from "../../indexeddb/src/storage";
import { chunkTextByEstimatedTokens } from "../../shared/src/text-chunking";
import { initializeRawMessageSchema } from "./schema";

type DatabaseLike = Database.Database;

interface RawMessageRow {
	id: number;
	message_id: string;
	platform: string;
	bot_id: string;
	user_id: string;
	channel: string | null;
	person: string | null;
	timestamp: number;
	content: string;
	attachments: string | null;
	embedding: Buffer | null;
	embedding_model: string | null;
	embedding_content_hash: string | null;
	embedding_dimensions: number | null;
	embedding_updated_at: number | null;
	metadata: string | null;
	created_at: number;
	memory_stage: MemoryStage | null;
	access_count: number | null;
	last_access_at: number | null;
	importance_score: number | null;
	archived_at: number | null;
	is_pinned: number | null;
	summary_ref_id: string | null;
	deprecated_at: number | null;
	deprecation_reason: string | null;
	superseded_by_summary_id: string | null;
	source_episode_id: string | null;
	fact_type: string | null;
}

interface RawMessageSearchChunkRow {
	id: number;
	chunk_id: string;
	message_id: string;
	user_id: string;
	chunk_index: number;
	chunk_count: number;
	start_position: number;
	end_position: number;
	content: string;
	content_hash: string;
	embedding: Buffer | null;
	embedding_model: string | null;
	embedding_dimensions: number | null;
	embedding_updated_at: number | null;
}

interface MemorySummaryRow {
	summary_id: string;
	user_id: string;
	summary_tier: "L1" | "L2" | "L3";
	source_tier: MemoryStage;
	start_timestamp: number;
	end_timestamp: number;
	message_count: number;
	source_record_ids: string | null;
	key_points: string | null;
	keywords: string | null;
	keywords_text: string | null;
	summary_text: string;
	dimensions: string | null;
	quality_score: number | null;
	created_at: number;
	updated_at: number;
}

export interface SQLiteRawMessageManagerOptions {
	dbPath?: string;
	db?: DatabaseLike;
	vectorDimensions?: number;
	enableVectorSearch?: boolean;
}

export interface SQLiteRawMessageSemanticSearchInput {
	userId: string;
	queryEmbedding: number[];
	embeddingModel?: string;
	limit?: number;
	scanLimit?: number;
	threshold?: number;
	includeArchived?: boolean;
	includeDeprecated?: boolean;
	platform?: string;
	botId?: string;
	channel?: string;
	person?: string;
	startTime?: number;
	endTime?: number;
	/** Optional `FactType` filter — narrows to rows whose `fact_type` is in this set. */
	factTypes?: Array<"world" | "experience" | "mental_model">;
}

export interface SQLiteRawMessageSemanticSearchResult {
	type: "memory";
	id: string;
	content: string;
	similarity: number;
	metadata: Record<string, unknown> & {
		userId: string;
		platform: string;
		botId: string;
		channel?: string;
		person?: string;
		timestamp: number;
		memoryStage?: string;
		embeddingModel?: string;
		factType?: "world" | "experience" | "mental_model";
	};
	message: RawMessage;
}

/**
 * BM25 lexical search powered by the existing `raw_messages_fts` virtual table.
 * The FTS5 `rank` column is exposed as `bm25Rank` so callers can fold it into
 * the unified RRF merge. Mirrors `SQLiteRawMessageSemanticSearchResult`'s
 * shape so the two sub-queries are interchangeable downstream.
 */
export interface SQLiteRawMessageLexicalSearchInput {
	userId: string;
	keywords: string[];
	limit?: number;
	includeArchived?: boolean;
	includeDeprecated?: boolean;
	platform?: string;
	botId?: string;
	/** Optional `FactType` filter — narrows to rows whose `fact_type` is in this set. */
	factTypes?: Array<"world" | "experience" | "mental_model">;
}

export interface SQLiteRawMessageLexicalSearchResult {
	type: "memory";
	id: string;
	content: string;
	similarity: number;
	bm25Rank: number;
	metadata: Record<string, unknown> & {
		userId: string;
		platform: string;
		botId: string;
		channel?: string;
		person?: string;
		timestamp: number;
		memoryStage?: string;
		factType?: "world" | "experience" | "mental_model";
		scoring: "bm25";
	};
	message: RawMessage;
}

function stringifyJson(value: unknown): string | null {
	if (value === undefined) {
		return null;
	}
	return JSON.stringify(value);
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
	if (!value) {
		return fallback;
	}
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function isUsableEmbedding(embedding: number[] | undefined): embedding is number[] {
	return Boolean(
		embedding?.length && embedding.every(Number.isFinite) && embedding.some((value) => value !== 0),
	);
}

function toSearchChunk(row: RawMessageSearchChunkRow): RawMessageSearchChunk {
	return {
		chunkId: row.chunk_id,
		messageId: row.message_id,
		userId: row.user_id,
		chunkIndex: row.chunk_index,
		chunkCount: row.chunk_count,
		startPosition: row.start_position,
		endPosition: row.end_position,
		content: row.content,
		contentHash: row.content_hash,
		embedding: row.embedding ? bufferToFloatArray(row.embedding) : undefined,
		embeddingModel: row.embedding_model ?? undefined,
		embeddingDimensions: row.embedding_dimensions ?? undefined,
		embeddingUpdatedAt: row.embedding_updated_at ?? undefined,
	};
}

function buildSearchChunks(message: RawMessage): RawMessageSearchChunk[] {
	const pieces = chunkTextByEstimatedTokens(message.content);
	return pieces.map((piece) => {
		const contentHash = sha256(piece.content);
		const canReuseParentEmbedding = pieces.length === 1 && isUsableEmbedding(message.embedding);
		return {
			chunkId: `${message.messageId}:chunk:${piece.chunkIndex}:${contentHash.slice(0, 16)}`,
			messageId: message.messageId,
			userId: message.userId,
			chunkIndex: piece.chunkIndex,
			chunkCount: pieces.length,
			startPosition: piece.startPosition,
			endPosition: piece.endPosition,
			content: piece.content,
			contentHash,
			embedding: canReuseParentEmbedding ? message.embedding : undefined,
			embeddingModel: canReuseParentEmbedding ? message.embeddingModel : undefined,
			embeddingDimensions: canReuseParentEmbedding
				? (message.embeddingDimensions ?? message.embedding?.length)
				: undefined,
			embeddingUpdatedAt: canReuseParentEmbedding ? message.embeddingUpdatedAt : undefined,
		};
	});
}

export function floatArrayToBuffer(values: number[] | undefined): Buffer | null {
	if (!values || values.length === 0) {
		return null;
	}
	const buffer = Buffer.allocUnsafe(values.length * 4);
	for (let index = 0; index < values.length; index += 1) {
		buffer.writeFloatLE(values[index], index * 4);
	}
	return buffer;
}

export function bufferToFloatArray(buffer: Buffer | null): number[] | undefined {
	if (!buffer || buffer.length === 0) {
		return undefined;
	}
	const values: number[] = [];
	for (let offset = 0; offset < buffer.length; offset += 4) {
		values.push(buffer.readFloatLE(offset));
	}
	return values;
}

function toRawMessage(row: RawMessageRow): RawMessage {
	return {
		id: row.id,
		messageId: row.message_id,
		platform: row.platform,
		botId: row.bot_id,
		userId: row.user_id,
		channel: row.channel ?? undefined,
		person: row.person ?? undefined,
		timestamp: row.timestamp,
		content: row.content,
		attachments: parseJson(row.attachments, undefined),
		embedding: bufferToFloatArray(row.embedding),
		embeddingModel: row.embedding_model ?? undefined,
		embeddingContentHash: row.embedding_content_hash ?? undefined,
		embeddingDimensions: row.embedding_dimensions ?? undefined,
		embeddingUpdatedAt: row.embedding_updated_at ?? undefined,
		metadata: parseJson(row.metadata, undefined),
		createdAt: row.created_at,
		memoryStage: row.memory_stage ?? "short",
		accessCount: row.access_count ?? 0,
		lastAccessAt: row.last_access_at ?? undefined,
		importanceScore: row.importance_score ?? 0,
		archivedAt: row.archived_at ?? undefined,
		isPinned: Boolean(row.is_pinned ?? 0),
		summaryRefId: row.summary_ref_id ?? undefined,
		deprecatedAt: row.deprecated_at ?? undefined,
		deprecationReason: row.deprecation_reason ?? undefined,
		supersededBySummaryId: row.superseded_by_summary_id ?? undefined,
		sourceEpisodeId: row.source_episode_id ?? undefined,
		factType: (row.fact_type as RawMessage["factType"]) ?? undefined,
	};
}

function toSummaryRecord(row: MemorySummaryRow): MemorySummaryRecord {
	return {
		summaryId: row.summary_id,
		userId: row.user_id,
		summaryTier: row.summary_tier,
		sourceTier: row.source_tier,
		startTimestamp: row.start_timestamp,
		endTimestamp: row.end_timestamp,
		messageCount: row.message_count,
		sourceRecordIds: parseJson(row.source_record_ids, []),
		keyPoints: parseJson(row.key_points, []),
		keywords: parseJson(row.keywords, []),
		keywordsText: row.keywords_text ?? undefined,
		summaryText: row.summary_text,
		dimensions: parseJson(row.dimensions, undefined),
		qualityScore: row.quality_score ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function buildFtsQuery(keywords: string[]): string {
	return keywords
		.map((keyword) => keyword.trim())
		.filter(Boolean)
		.map((keyword) => `"${keyword.replace(/"/g, '""')}"`)
		.join(" OR ");
}

function cosineSimilarity(vecA: number[], vecB: number[]): number {
	if (vecA.length === 0 || vecA.length !== vecB.length) {
		return Number.NaN;
	}

	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let index = 0; index < vecA.length; index += 1) {
		dot += vecA[index] * vecB[index];
		normA += vecA[index] * vecA[index];
		normB += vecB[index] * vecB[index];
	}

	if (normA === 0 || normB === 0) {
		return Number.NaN;
	}
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function sqliteDistanceToScore(distance: number): number {
	if (!Number.isFinite(distance)) {
		return 0;
	}
	return 1 / (1 + Math.max(0, distance));
}

/**
 * Convert an sqlite-vec L2 distance to cosine similarity.
 * Embeddings are L2-normalized by the local transformer provider, so
 * `cosine_similarity = 1 - distance^2 / 2`.
 */
function sqliteVectorDistanceToCosineSimilarity(distance: number): number {
	if (!Number.isFinite(distance)) {
		return 0;
	}
	return Math.max(-1, 1 - (distance * distance) / 2);
}

function normalizeTimestampToMs(value: number): number {
	if (value < 1e11) {
		return Math.floor(value * 1000);
	}
	return Math.floor(value);
}

function currentUnixSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

export class SQLiteRawMessageManager implements RawMessageStorageManager {
	private readonly db: DatabaseLike;
	private readonly ownsConnection: boolean;
	private readonly enableVectorSearch: boolean;
	private initialized = false;
	private vectorSearchAvailable = false;

	constructor(options: SQLiteRawMessageManagerOptions | string = ":memory:") {
		if (typeof options === "string") {
			this.db = new Database(options);
			this.ownsConnection = true;
			this.enableVectorSearch = true;
			return;
		}

		if (options.db) {
			this.db = options.db;
			this.ownsConnection = false;
			this.enableVectorSearch = options.enableVectorSearch ?? true;
			return;
		}

		this.db = new Database(options.dbPath ?? ":memory:");
		this.ownsConnection = true;
		this.enableVectorSearch = options.enableVectorSearch ?? true;
	}

	async init(): Promise<void> {
		if (this.initialized) {
			return;
		}
		initializeRawMessageSchema(this.db);
		this.initializeVectorSearch();
		this.initialized = true;
	}

	async close(): Promise<void> {
		if (this.ownsConnection) {
			this.db.close();
		}
		this.initialized = false;
	}

	async storeMessage(message: RawMessage): Promise<number> {
		const ids = await this.storeMessages([message]);
		return ids[0] ?? 0;
	}

	async storeMessages(messages: RawMessage[]): Promise<number[]> {
		return this.storeMessagesWithSearchChunks(
			messages,
			messages.flatMap((message) => buildSearchChunks(message)),
		);
	}

	async storeMessagesWithSearchChunks(
		messages: RawMessage[],
		chunks: RawMessageSearchChunk[],
	): Promise<number[]> {
		await this.init();
		const ids: number[] = [];
		const chunksByMessage = new Map<string, RawMessageSearchChunk[]>();
		for (const chunk of chunks) {
			const group = chunksByMessage.get(chunk.messageId) ?? [];
			group.push(chunk);
			chunksByMessage.set(chunk.messageId, group);
		}
		const insertMany = this.db.transaction((items: RawMessage[]) => {
			for (const message of items) {
				const existing = this.storeMessageSync(message);
				ids.push(existing);
				this.replaceSearchChunksSync(
					message,
					chunksByMessage.get(message.messageId) ?? buildSearchChunks(message),
				);
			}
		});
		insertMany.immediate(messages);
		return ids;
	}

	async getRawMessageSearchChunks(input: {
		chunkIds?: string[];
		messageIds?: string[];
		userId?: string;
	}): Promise<RawMessageSearchChunk[]> {
		await this.init();
		const where: string[] = [];
		const params: Record<string, unknown> = {};
		const addList = (column: string, prefix: string, values: string[] | undefined) => {
			const unique = Array.from(new Set(values?.filter(Boolean) ?? []));
			if (unique.length === 0) return;
			const placeholders = unique.map((value, index) => {
				params[`${prefix}${index}`] = value;
				return `@${prefix}${index}`;
			});
			where.push(`${column} IN (${placeholders.join(", ")})`);
		};
		addList("chunk_id", "chunkId", input.chunkIds);
		addList("message_id", "messageId", input.messageIds);
		if (input.userId) {
			where.push("user_id = @userId");
			params.userId = input.userId;
		}
		if (where.length === 0) return [];
		return (
			this.db
				.prepare(
					`SELECT * FROM raw_message_chunks WHERE ${where.join(" AND ")} ORDER BY message_id, chunk_index`,
				)
				.all(params) as RawMessageSearchChunkRow[]
		).map(toSearchChunk);
	}

	async getRawMessageSearchIndexStats(): Promise<RawMessageSearchIndexStats> {
		await this.init();
		const counts = this.db
			.prepare(`
        SELECT
          COUNT(DISTINCT message_id) AS message_count,
          COUNT(*) AS chunk_count,
          SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded_chunk_count
        FROM raw_message_chunks
      `)
			.get() as { message_count: number; chunk_count: number; embedded_chunk_count: number | null };
		const dimensions = (
			this.db
				.prepare(
					"SELECT DISTINCT embedding_dimensions AS dimensions FROM raw_message_chunks WHERE embedding_dimensions IS NOT NULL ORDER BY dimensions",
				)
				.all() as Array<{ dimensions: number }>
		).map((row) => row.dimensions);
		return {
			messageCount: counts.message_count,
			chunkCount: counts.chunk_count,
			embeddedChunkCount: counts.embedded_chunk_count ?? 0,
			embeddingDimensions: dimensions,
			lexicalReady: this.tableExists("raw_message_chunks_fts"),
			semanticReady:
				(counts.embedded_chunk_count ?? 0) > 0 && dimensions.some((d) => this.childVectorTableExists(d)),
		};
	}

	async compareAndSwapGraphLedger(
		message: RawMessage,
		input: { expectedVersion: string; metadataKey: string },
	): Promise<boolean> {
		await this.init();
		const compareAndSwap = this.db.transaction(() => {
			const existing = this.db
				.prepare("SELECT user_id, metadata FROM raw_messages WHERE message_id = ?")
				.get(message.messageId) as { user_id: string; metadata: string | null } | undefined;
			if (existing && existing.user_id !== message.userId) return false;

			const metadata = parseJson<Record<string, unknown>>(existing?.metadata, {});
			const ledger = metadata[input.metadataKey] as { snapshot?: { version?: unknown } } | undefined;
			const currentVersion = typeof ledger?.snapshot?.version === "string" ? ledger.snapshot.version : "0";
			if (currentVersion !== input.expectedVersion) return false;

			this.storeMessageSync(message);
			return true;
		});
		return compareAndSwap.immediate();
	}

	async queryMessages(query: RawMessageQuery): Promise<RawMessage[]> {
		await this.init();

		const where: string[] = [];
		const params: Record<string, unknown> = {};

		if (query.userId) {
			where.push("user_id = @userId");
			params.userId = query.userId;
		}
		if (query.platform) {
			where.push("platform = @platform");
			params.platform = query.platform;
		}
		if (query.botId) {
			where.push("bot_id = @botId");
			params.botId = query.botId;
		}
		if (query.channel) {
			where.push("lower(coalesce(channel, '')) LIKE @channel ESCAPE '\\'");
			params.channel = `%${escapeLike(query.channel.toLowerCase())}%`;
		}
		if (query.person) {
			where.push("lower(coalesce(person, '')) LIKE @person ESCAPE '\\'");
			params.person = `%${escapeLike(query.person.toLowerCase())}%`;
		}
		if (query.startTime !== undefined) {
			where.push("timestamp >= @startTime");
			params.startTime = query.startTime;
		}
		if (query.endTime !== undefined) {
			where.push("timestamp < @endTime");
			params.endTime = query.endTime;
		}
		if (query.memoryStages?.length) {
			where.push(
				`coalesce(memory_stage, 'short') IN (${query.memoryStages
					.map((_, index) => `@memoryStage${index}`)
					.join(", ")})`,
			);
			query.memoryStages.forEach((stage, index) => {
				params[`memoryStage${index}`] = stage;
			});
		}
		if (query.factTypes?.length) {
			where.push(`fact_type IN (${query.factTypes.map((_, index) => `@factType${index}`).join(", ")})`);
			query.factTypes.forEach((factType, index) => {
				params[`factType${index}`] = factType;
			});
		}
		if (!query.includeArchived) {
			where.push("archived_at IS NULL");
		}
		if (!query.includeDeprecated) {
			// Soft-hide deprecated records by default. Backed by the partial index
			// `idx_raw_messages_active_user` (`WHERE deprecated_at IS NULL`).
			where.push("deprecated_at IS NULL");
		}
		if (query.keywords?.length) {
			const ftsQuery = buildFtsQuery(query.keywords);
			if (ftsQuery) {
				where.push("id IN (SELECT rowid FROM raw_messages_fts WHERE raw_messages_fts MATCH @ftsQuery)");
				params.ftsQuery = ftsQuery;
			}
		}

		const order = query.reverse ? "DESC" : "ASC";
		params.limit = query.pageSize ?? query.limit ?? 50;
		params.offset = query.offset ?? 0;

		const sql = `
      SELECT *
      FROM raw_messages
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY timestamp ${order}, id ${order}
      LIMIT @limit OFFSET @offset
    `;

		return (this.db.prepare(sql).all(params) as RawMessageRow[]).map(toRawMessage);
	}

	async queryMessagesGrouped(query: RawMessageQuery): Promise<Record<string, RawMessage[]>> {
		const messages = await this.queryMessages({
			...query,
			limit: query.limit ? query.limit * 10 : 1000,
		});

		if (messages.length === 0 || query.groupBy === "none" || !query.groupBy) {
			return { all: messages };
		}

		const grouped: Record<string, RawMessage[]> = {};
		const now = new Date();
		const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const yesterday = new Date(today);
		yesterday.setDate(yesterday.getDate() - 1);

		for (const message of messages) {
			const date = new Date(message.timestamp * 1000);
			let key = date.toISOString().split("T")[0];

			if (query.groupBy === "day") {
				const localDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
				if (localDate.getTime() === today.getTime()) {
					key = "Today";
				} else if (localDate.getTime() === yesterday.getTime()) {
					key = "Yesterday";
				}
			} else if (query.groupBy === "week") {
				const dayOfWeek = date.getDay();
				const monday = new Date(date);
				monday.setDate(date.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
				key = `Week of ${monday.toISOString().split("T")[0]}`;
			} else if (query.groupBy === "month") {
				key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
			}

			grouped[key] = grouped[key] ?? [];
			grouped[key].push(message);
		}

		const sorted: Record<string, RawMessage[]> = {};
		for (const key of Object.keys(grouped).sort((a, b) => {
			if (a === "Today") return -1;
			if (b === "Today") return 1;
			if (a === "Yesterday") return -1;
			if (b === "Yesterday") return 1;
			return b.localeCompare(a);
		})) {
			sorted[key] = grouped[key];
		}
		return sorted;
	}

	async getStats(): Promise<RawMessageStats> {
		await this.init();
		const total = this.db.prepare("SELECT COUNT(*) AS count FROM raw_messages").get() as { count: number };
		const platforms = this.db
			.prepare("SELECT platform, COUNT(*) AS count FROM raw_messages GROUP BY platform")
			.all() as Array<{ platform: string; count: number }>;
		const bots = this.db
			.prepare("SELECT bot_id, COUNT(*) AS count FROM raw_messages GROUP BY bot_id")
			.all() as Array<{ bot_id: string; count: number }>;
		const times = this.db
			.prepare("SELECT MIN(timestamp) AS oldest, MAX(timestamp) AS newest FROM raw_messages")
			.get() as { oldest: number | null; newest: number | null };

		return {
			totalMessages: total.count,
			messagesByPlatform: Object.fromEntries(platforms.map((row) => [row.platform, row.count])),
			messagesByBot: Object.fromEntries(bots.map((row) => [row.bot_id, row.count])),
			oldestMessage: times.oldest ?? undefined,
			newestMessage: times.newest ?? undefined,
		};
	}

	async getMessageById(messageId: string): Promise<RawMessage | null> {
		await this.init();
		const row = this.db.prepare("SELECT * FROM raw_messages WHERE message_id = ?").get(messageId) as
			| RawMessageRow
			| undefined;
		return row ? toRawMessage(row) : null;
	}

	async deleteOldMessages(olderThan: number, userId?: string): Promise<number> {
		await this.init();
		const ids = (
			userId
				? this.db
						.prepare("SELECT message_id FROM raw_messages WHERE created_at < ? AND user_id = ?")
						.all(olderThan, userId)
				: this.db.prepare("SELECT message_id FROM raw_messages WHERE created_at < ?").all(olderThan)
		) as Array<{ message_id: string }>;
		const result = userId
			? this.db
					.prepare("DELETE FROM raw_messages WHERE created_at < ? AND user_id = ?")
					.run(olderThan, userId)
			: this.db.prepare("DELETE FROM raw_messages WHERE created_at < ?").run(olderThan);
		for (const row of ids) {
			this.deleteMessageFromVectorTables(row.message_id);
		}
		return result.changes;
	}

	async clearAll(): Promise<void> {
		await this.init();
		this.db.exec(`
      DELETE FROM raw_messages;
      DELETE FROM memory_summaries;
      INSERT INTO raw_messages_fts(raw_messages_fts) VALUES('rebuild');
      INSERT INTO raw_message_chunks_fts(raw_message_chunks_fts) VALUES('rebuild');
    `);
		this.clearVectorTable();
		this.clearChildVectorTables();
	}

	async upsertSummaries(summaries: MemorySummaryRecord[]): Promise<void> {
		await this.init();
		const stmt = this.db.prepare(`
      INSERT INTO memory_summaries (
        summary_id, user_id, summary_tier, source_tier, start_timestamp,
        end_timestamp, message_count, source_record_ids, key_points, keywords,
        keywords_text, summary_text, dimensions, quality_score, created_at,
        updated_at
      )
      VALUES (
        @summaryId, @userId, @summaryTier, @sourceTier, @startTimestamp,
        @endTimestamp, @messageCount, @sourceRecordIds, @keyPoints, @keywords,
        @keywordsText, @summaryText, @dimensions, @qualityScore, @createdAt,
        @updatedAt
      )
      ON CONFLICT(summary_id) DO UPDATE SET
        summary_tier = excluded.summary_tier,
        source_tier = excluded.source_tier,
        start_timestamp = excluded.start_timestamp,
        end_timestamp = excluded.end_timestamp,
        message_count = excluded.message_count,
        source_record_ids = excluded.source_record_ids,
        key_points = excluded.key_points,
        keywords = excluded.keywords,
        keywords_text = excluded.keywords_text,
        summary_text = excluded.summary_text,
        dimensions = excluded.dimensions,
        quality_score = excluded.quality_score,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
      WHERE memory_summaries.user_id = excluded.user_id
    `);
		const readExisting = this.db.prepare(
			"SELECT user_id, dimensions FROM memory_summaries WHERE summary_id = ?",
		);

		const upsertMany = this.db.transaction((items: MemorySummaryRecord[]) => {
			const owners = new Map<string, string>();
			for (const summary of items) {
				const duplicateOwner = owners.get(summary.summaryId);
				if (duplicateOwner !== undefined) {
					throw new Error(
						duplicateOwner === summary.userId
							? MEMORY_SUMMARY_WRITE_CONFLICT
							: MEMORY_SUMMARY_OWNER_SCOPE_CONFLICT,
					);
				}
				owners.set(summary.summaryId, summary.userId);

				const existing = readExisting.get(summary.summaryId) as
					| { user_id: string; dimensions: string | null }
					| undefined;
				if (existing && existing.user_id !== summary.userId) {
					throw new Error(MEMORY_SUMMARY_OWNER_SCOPE_CONFLICT);
				}
				if (
					existing &&
					hasMemorySummaryPublicationRevisionConflict(
						{ dimensions: parseJson(existing.dimensions, {}) },
						summary,
					)
				) {
					throw new Error(MEMORY_SUMMARY_WRITE_CONFLICT);
				}
				if (
					existing &&
					!isMemorySummaryPublicationPendingRecord({
						dimensions: parseJson(existing.dimensions, {}),
					}) &&
					isMemorySummaryPublicationPendingRecord(summary)
				) {
					continue;
				}

				const persistedSummary = withoutMemorySummaryPublicationExpectedRevision(summary);
				const result = stmt.run({
					summaryId: persistedSummary.summaryId,
					userId: persistedSummary.userId,
					summaryTier: persistedSummary.summaryTier,
					sourceTier: persistedSummary.sourceTier,
					startTimestamp: persistedSummary.startTimestamp,
					endTimestamp: persistedSummary.endTimestamp,
					messageCount: persistedSummary.messageCount,
					sourceRecordIds: stringifyJson(persistedSummary.sourceRecordIds),
					keyPoints: stringifyJson(persistedSummary.keyPoints),
					keywords: stringifyJson(persistedSummary.keywords),
					keywordsText: persistedSummary.keywordsText ?? persistedSummary.keywords.join(" "),
					summaryText: persistedSummary.summaryText,
					dimensions: stringifyJson(persistedSummary.dimensions),
					qualityScore: persistedSummary.qualityScore ?? null,
					createdAt: persistedSummary.createdAt,
					updatedAt: persistedSummary.updatedAt,
				});
				if (result.changes !== 1) {
					const current = readExisting.get(summary.summaryId) as
						| { user_id: string; dimensions: string | null }
						| undefined;
					if (current?.user_id !== summary.userId) {
						throw new Error(MEMORY_SUMMARY_OWNER_SCOPE_CONFLICT);
					}
					throw new Error(MEMORY_SUMMARY_WRITE_CONFLICT);
				}
			}
		});
		upsertMany.immediate(summaries);
	}

	async querySummaries(query: MemorySummaryQuery): Promise<MemorySummaryRecord[]> {
		await this.init();

		const where: string[] = ["user_id = @userId"];
		const params: Record<string, unknown> = { userId: query.userId };

		if (query.summaryIds?.length) {
			where.push(`summary_id IN (${query.summaryIds.map((_, index) => `@summaryId${index}`).join(", ")})`);
			query.summaryIds.forEach((summaryId, index) => {
				params[`summaryId${index}`] = summaryId;
			});
		}

		if (query.summaryTiers?.length) {
			where.push(
				`summary_tier IN (${query.summaryTiers.map((_, index) => `@summaryTier${index}`).join(", ")})`,
			);
			query.summaryTiers.forEach((tier, index) => {
				params[`summaryTier${index}`] = tier;
			});
		}
		if (query.startTime !== undefined) {
			where.push("end_timestamp >= @startTime");
			params.startTime = query.startTime;
		}
		if (query.endTime !== undefined) {
			where.push("start_timestamp < @endTime");
			params.endTime = query.endTime;
		}
		if (query.keywords?.length) {
			query.keywords.forEach((keyword, index) => {
				where.push(
					`(lower(coalesce(keywords_text, '')) LIKE @keyword${index} ESCAPE '\\' OR lower(summary_text) LIKE @keyword${index} ESCAPE '\\')`,
				);
				params[`keyword${index}`] = `%${escapeLike(keyword.toLowerCase())}%`;
			});
		}

		const order = (query.reverse ?? true) ? "DESC" : "ASC";
		const rows = this.db
			.prepare(
				`
          SELECT *
          FROM memory_summaries
          WHERE ${where.join(" AND ")}
          ORDER BY end_timestamp ${order}
        `,
			)
			.all(params) as MemorySummaryRow[];

		let summaries = rows.map(toSummaryRecord);
		if (query.dimensions) {
			summaries = summaries.filter((summary) => {
				const dimensions = summary.dimensions ?? {};
				return Object.entries(query.dimensions ?? {}).every(
					([key, value]) => value === undefined || dimensions[key] === value,
				);
			});
		}

		const offset = query.offset ?? 0;
		const pageSize = query.pageSize ?? query.limit ?? 50;
		return summaries.slice(offset, offset + pageSize);
	}

	async markMessagesAccessed(messageIds: string[], at = Date.now(), userId?: string): Promise<number> {
		await this.init();
		return this.updateMessagesByMessageIds(
			messageIds,
			`
        access_count = coalesce(access_count, 0) + 1,
        last_access_at = @at
      `,
			{ at },
			userId,
		);
	}

	async promoteMessagesToStage(
		messageIds: string[],
		stage: MemoryStage,
		options?: { userId?: string; summaryRefId?: string; promotedAt?: number },
	): Promise<number> {
		await this.init();
		const existingRows = this.getRowsByMessageIds(messageIds, options?.userId);
		let changed = 0;
		const stmt = this.db.prepare(`
      UPDATE raw_messages
      SET memory_stage = @stage,
          summary_ref_id = @summaryRefId,
          metadata = @metadata
      WHERE message_id = @messageId
    `);
		const updateMany = this.db.transaction((rows: RawMessageRow[]) => {
			for (const row of rows) {
				const metadata = {
					...parseJson<Record<string, unknown>>(row.metadata, {}),
					...(options?.promotedAt ? { memoryPromotedAt: options.promotedAt } : {}),
				};
				changed += stmt.run({
					stage,
					summaryRefId: options?.summaryRefId ?? row.summary_ref_id,
					metadata: stringifyJson(metadata),
					messageId: row.message_id,
				}).changes;
			}
		});
		updateMany(existingRows);
		return changed;
	}

	async archiveMessages(messageIds: string[], archivedAt = Date.now(), userId?: string): Promise<number> {
		await this.init();
		return this.updateMessagesByMessageIds(messageIds, "archived_at = @archivedAt", { archivedAt }, userId);
	}

	/**
	 * Soft-deprecate messages: write `deprecated_at` (+ optional reason /
	 * superseded_by_summary_id) without deleting the rows. Idempotent — the
	 * `WHERE deprecated_at IS NULL` guard means re-running on the same ids
	 * returns 0 affected rows.
	 */
	async deprecateMessages(
		messageIds: string[],
		input: {
			userId?: string;
			deprecatedAt?: number;
			reason?: string;
			supersededBySummaryId?: string;
		} = {},
	): Promise<number> {
		await this.init();
		if (messageIds.length === 0) return 0;
		const deprecatedAt = input.deprecatedAt ?? Date.now();
		const reason = input.reason ?? null;
		const supersededBySummaryId = input.supersededBySummaryId ?? null;

		const placeholders = messageIds.map(() => "?").join(",");
		const userClause = input.userId ? "AND user_id = ?" : "";
		const result = this.db
			.prepare(
				`UPDATE raw_messages
            SET deprecated_at = ?,
                deprecation_reason = ?,
                superseded_by_summary_id = ?
          WHERE message_id IN (${placeholders})
            AND deprecated_at IS NULL
            ${userClause}`,
			)
			.run(
				deprecatedAt,
				reason,
				supersededBySummaryId,
				...messageIds,
				...(input.userId ? [input.userId] : []),
			);
		return result.changes;
	}

	async restoreDeprecatedMessages(
		messageIds: string[],
		input: { userId?: string; supersededBySummaryId?: string } = {},
	): Promise<number> {
		await this.init();
		if (messageIds.length === 0) return 0;
		const placeholders = messageIds.map(() => "?").join(",");
		const userClause = input.userId ? "AND user_id = ?" : "";
		const summaryClause = input.supersededBySummaryId ? "AND superseded_by_summary_id = ?" : "";
		const result = this.db
			.prepare(
				`UPDATE raw_messages
            SET deprecated_at = NULL,
                deprecation_reason = NULL,
                superseded_by_summary_id = NULL
          WHERE message_id IN (${placeholders})
            AND deprecated_at IS NOT NULL
            ${userClause}
            ${summaryClause}`,
			)
			.run(
				...messageIds,
				...(input.userId ? [input.userId] : []),
				...(input.supersededBySummaryId ? [input.supersededBySummaryId] : []),
			);
		return result.changes;
	}

	async hardDeleteArchived(olderThan: number, userId?: string): Promise<number> {
		await this.init();
		const ids = (
			userId
				? this.db
						.prepare(
							"SELECT message_id FROM raw_messages WHERE archived_at IS NOT NULL AND archived_at < ? AND user_id = ?",
						)
						.all(olderThan, userId)
				: this.db
						.prepare("SELECT message_id FROM raw_messages WHERE archived_at IS NOT NULL AND archived_at < ?")
						.all(olderThan)
		) as Array<{ message_id: string }>;
		const result = userId
			? this.db
					.prepare(
						"DELETE FROM raw_messages WHERE archived_at IS NOT NULL AND archived_at < ? AND user_id = ?",
					)
					.run(olderThan, userId)
			: this.db
					.prepare("DELETE FROM raw_messages WHERE archived_at IS NOT NULL AND archived_at < ?")
					.run(olderThan);
		for (const row of ids) {
			this.deleteMessageFromVectorTables(row.message_id);
		}
		return result.changes;
	}

	async updateMessageEmbeddings(updates: RawMessageEmbeddingUpdate[], userId?: string): Promise<number> {
		await this.init();
		const stmt = this.db.prepare(`
      UPDATE raw_messages
      SET embedding = @embedding,
          embedding_model = @embeddingModel,
          embedding_content_hash = @embeddingContentHash,
          embedding_dimensions = @embeddingDimensions,
          embedding_updated_at = @embeddingUpdatedAt
      WHERE message_id = @messageId
      ${userId ? "AND user_id = @userId" : ""}
    `);
		let changed = 0;
		const updateMany = this.db.transaction((items: RawMessageEmbeddingUpdate[]) => {
			for (const update of items) {
				changed += stmt.run({
					messageId: update.messageId,
					embedding: floatArrayToBuffer(update.embedding),
					embeddingModel: update.embeddingModel,
					embeddingContentHash: update.embeddingContentHash,
					embeddingDimensions: update.embeddingDimensions ?? update.embedding.length,
					embeddingUpdatedAt: update.embeddingUpdatedAt ?? Date.now(),
					userId,
				}).changes;
				this.upsertVectorForMessage(update.messageId, update.embedding);
				const child = this.db
					.prepare(
						"SELECT chunk_id, chunk_count, content_hash FROM raw_message_chunks WHERE message_id = ? AND chunk_index = 0",
					)
					.get(update.messageId) as
					| { chunk_id: string; chunk_count: number; content_hash: string }
					| undefined;
				if (child?.chunk_count === 1 && child.content_hash === update.embeddingContentHash) {
					this.db
						.prepare(`
              UPDATE raw_message_chunks
              SET embedding = ?, embedding_model = ?, embedding_dimensions = ?, embedding_updated_at = ?
              WHERE chunk_id = ?
            `)
						.run(
							floatArrayToBuffer(update.embedding),
							update.embeddingModel,
							update.embeddingDimensions ?? update.embedding.length,
							update.embeddingUpdatedAt ?? Date.now(),
							child.chunk_id,
						);
					this.upsertVectorForSearchChunk(child.chunk_id, update.embedding);
				}
			}
		});
		updateMany(updates.filter((update) => update.messageId));
		return changed;
	}

	private storeMessageSync(message: RawMessage): number {
		const persistedRow = this.db
			.prepare("SELECT * FROM raw_messages WHERE message_id = ?")
			.get(message.messageId) as RawMessageRow | undefined;
		if (persistedRow && persistedRow.user_id !== message.userId) {
			throw new Error("raw_message_scope_conflict");
		}
		const persisted = persistedRow ? toRawMessage(persistedRow) : undefined;
		const messageToStore = persisted ? mergeStoredChatMemoryEvidence(persisted, message) : message;
		const normalized = {
			...messageToStore,
			memoryStage: messageToStore.memoryStage ?? "short",
			accessCount: messageToStore.accessCount ?? 0,
			importanceScore: messageToStore.importanceScore ?? 0,
			isPinned: messageToStore.isPinned ?? false,
			createdAt: messageToStore.createdAt ?? currentUnixSeconds(),
		};

		const result = this.db
			.prepare(
				`
          INSERT INTO raw_messages (
            message_id, platform, bot_id, user_id, channel, person, timestamp,
            content, attachments, embedding, embedding_model,
            embedding_content_hash, embedding_dimensions, embedding_updated_at,
            metadata, created_at, memory_stage, access_count, last_access_at,
            importance_score, archived_at, is_pinned, summary_ref_id,
            source_episode_id, fact_type
          )
          VALUES (
            @messageId, @platform, @botId, @userId, @channel, @person,
            @timestamp, @content, @attachments, @embedding, @embeddingModel,
            @embeddingContentHash, @embeddingDimensions, @embeddingUpdatedAt,
            @metadata, @createdAt, @memoryStage, @accessCount, @lastAccessAt,
            @importanceScore, @archivedAt, @isPinned, @summaryRefId,
            @sourceEpisodeId, @factType
          )
          ON CONFLICT(message_id) DO UPDATE SET
            platform = excluded.platform,
            bot_id = excluded.bot_id,
            user_id = excluded.user_id,
            channel = excluded.channel,
            person = excluded.person,
            timestamp = excluded.timestamp,
            content = excluded.content,
            attachments = excluded.attachments,
            embedding = excluded.embedding,
            embedding_model = excluded.embedding_model,
            embedding_content_hash = excluded.embedding_content_hash,
            embedding_dimensions = excluded.embedding_dimensions,
            embedding_updated_at = excluded.embedding_updated_at,
            metadata = excluded.metadata,
            created_at = excluded.created_at,
            memory_stage = excluded.memory_stage,
            access_count = excluded.access_count,
            last_access_at = excluded.last_access_at,
            importance_score = excluded.importance_score,
            archived_at = excluded.archived_at,
            is_pinned = excluded.is_pinned,
            summary_ref_id = excluded.summary_ref_id,
            source_episode_id = excluded.source_episode_id,
            fact_type = excluded.fact_type
          WHERE raw_messages.user_id = excluded.user_id
        `,
			)
			.run({
				messageId: normalized.messageId,
				platform: normalized.platform,
				botId: normalized.botId,
				userId: normalized.userId,
				channel: normalized.channel ?? null,
				person: normalized.person ?? null,
				timestamp: normalized.timestamp,
				content: normalized.content,
				attachments: stringifyJson(normalized.attachments),
				embedding: floatArrayToBuffer(normalized.embedding),
				embeddingModel: normalized.embeddingModel ?? null,
				embeddingContentHash: normalized.embeddingContentHash ?? null,
				embeddingDimensions: normalized.embeddingDimensions ?? normalized.embedding?.length ?? null,
				embeddingUpdatedAt: normalized.embeddingUpdatedAt ?? null,
				metadata: stringifyJson(normalized.metadata),
				createdAt: normalized.createdAt,
				memoryStage: normalized.memoryStage,
				accessCount: normalized.accessCount,
				lastAccessAt: normalized.lastAccessAt ?? null,
				importanceScore: normalized.importanceScore,
				archivedAt: normalized.archivedAt ?? null,
				isPinned: normalized.isPinned ? 1 : 0,
				summaryRefId: normalized.summaryRefId ?? null,
				sourceEpisodeId: normalized.sourceEpisodeId ?? null,
				factType: normalized.factType ?? null,
			});

		if (result.changes === 0) {
			throw new Error("raw_message_scope_conflict");
		}

		const row = this.db
			.prepare("SELECT id FROM raw_messages WHERE message_id = ?")
			.get(normalized.messageId) as { id: number };
		this.upsertVectorForMessage(normalized.messageId, normalized.embedding);
		return row.id;
	}

	private replaceSearchChunksSync(message: RawMessage, chunks: RawMessageSearchChunk[]): void {
		const ordered = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
		for (const chunk of ordered) {
			if (chunk.messageId !== message.messageId || chunk.userId !== message.userId) {
				throw new Error(`raw_message_chunk_scope_conflict:${chunk.chunkId}`);
			}
			if (
				chunk.chunkIndex < 0 ||
				chunk.chunkCount !== ordered.length ||
				chunk.endPosition <= chunk.startPosition ||
				chunk.content !== message.content.slice(chunk.startPosition, chunk.endPosition) ||
				chunk.contentHash !== sha256(chunk.content)
			) {
				throw new Error(`invalid_raw_message_chunk:${chunk.chunkId}`);
			}
		}
		this.deleteSearchChunksForMessage(message.messageId);
		const insert = this.db.prepare(`
      INSERT INTO raw_message_chunks (
        chunk_id, message_id, user_id, chunk_index, chunk_count,
        start_position, end_position, content, content_hash, embedding,
        embedding_model, embedding_dimensions, embedding_updated_at
      ) VALUES (
        @chunkId, @messageId, @userId, @chunkIndex, @chunkCount,
        @startPosition, @endPosition, @content, @contentHash, @embedding,
        @embeddingModel, @embeddingDimensions, @embeddingUpdatedAt
      )
    `);
		for (const chunk of ordered) {
			const dimensions = chunk.embeddingDimensions ?? chunk.embedding?.length;
			if (chunk.embedding && dimensions !== chunk.embedding.length) {
				throw new Error(`raw_message_chunk_embedding_dimension_mismatch:${chunk.chunkId}`);
			}
			const embedding = isUsableEmbedding(chunk.embedding) ? chunk.embedding : undefined;
			insert.run({
				...chunk,
				embedding: floatArrayToBuffer(embedding),
				embeddingModel: embedding ? (chunk.embeddingModel ?? null) : null,
				embeddingDimensions: embedding ? (dimensions ?? null) : null,
				embeddingUpdatedAt: embedding ? (chunk.embeddingUpdatedAt ?? null) : null,
			});
			this.upsertVectorForSearchChunk(chunk.chunkId, embedding);
		}
	}

	private deleteSearchChunksForMessage(messageId: string): void {
		for (const tableName of this.listChildVectorTables()) {
			this.db
				.prepare(
					`DELETE FROM ${tableName} WHERE chunk_id IN (SELECT chunk_id FROM raw_message_chunks WHERE message_id = ?)`,
				)
				.run(messageId);
		}
		this.db.prepare("DELETE FROM raw_message_chunks WHERE message_id = ?").run(messageId);
	}

	async searchMessagesSemantically(
		input: SQLiteRawMessageSemanticSearchInput,
	): Promise<SQLiteRawMessageSemanticSearchResult[]> {
		await this.init();

		if (input.queryEmbedding.length === 0) {
			return [];
		}

		const limit = Math.max(1, Math.floor(input.limit ?? 10));
		const childResults =
			this.vectorSearchAvailable && this.childVectorTableExists(input.queryEmbedding.length)
				? this.searchChunksWithVectorTable(input)
				: this.searchChunksWithStoredEmbeddings(input);
		const legacyResults = (
			this.vectorSearchAvailable && this.vectorTableExists(input.queryEmbedding.length)
				? this.searchMessagesWithVectorTable(input)
				: this.searchMessagesWithStoredEmbeddings(input)
		).filter((hit) => !this.messageHasSearchChunks(hit.id));
		return [...childResults, ...legacyResults].sort((a, b) => b.similarity - a.similarity).slice(0, limit);
	}

	/**
	 * Lexical (BM25) sub-query powered by `raw_messages_fts`. Lower scores are
	 * better in FTS5; we negate `rank` into `similarity` so downstream merging
	 * can treat this list identically to the semantic list.
	 *
	 * Backward-compatible: empty `keywords` short-circuits to `[]`. The
	 * underlying FTS5 query is shared with `queryMessages` via
	 * `buildFtsQuery`, so the two paths agree on tokenisation rules.
	 */
	async lexicalSearchMessages(
		input: SQLiteRawMessageLexicalSearchInput,
	): Promise<SQLiteRawMessageLexicalSearchResult[]> {
		await this.init();

		const keywords = input.keywords?.map((keyword) => keyword.trim()).filter(Boolean) ?? [];
		if (keywords.length === 0) {
			return [];
		}

		const ftsQuery = buildFtsQuery(keywords);
		if (!ftsQuery) {
			return [];
		}

		const where: string[] = [
			"raw_message_chunks_fts MATCH @ftsQuery",
			"raw_message_chunks.id = raw_message_chunks_fts.rowid",
			"raw_messages.message_id = raw_message_chunks.message_id",
			"raw_messages.user_id = @userId",
		];
		const params: Record<string, unknown> = {
			ftsQuery,
			userId: input.userId,
		};

		if (!input.includeArchived) {
			where.push("raw_messages.archived_at IS NULL");
		}
		if (!input.includeDeprecated) {
			where.push("raw_messages.deprecated_at IS NULL");
		}
		if (input.platform) {
			where.push("raw_messages.platform = @platform");
			params.platform = input.platform;
		}
		if (input.botId) {
			where.push("raw_messages.bot_id = @botId");
			params.botId = input.botId;
		}
		if (input.factTypes && input.factTypes.length > 0) {
			where.push(
				`raw_messages.fact_type IN (${input.factTypes.map((_, i) => `@lexFactType${i}`).join(", ")})`,
			);
			input.factTypes.forEach((factType, i) => {
				params[`lexFactType${i}`] = factType;
			});
		}

		const limit = Math.max(1, Math.floor(input.limit ?? 10));
		params.limit = Math.min(4096, Math.max(limit, limit * 4));

		const sql = `
			SELECT raw_message_chunks.*, raw_message_chunks_fts.rank AS bm25_rank
			FROM raw_message_chunks_fts, raw_message_chunks, raw_messages
			WHERE ${where.join(" AND ")}
			ORDER BY bm25_rank ASC
			LIMIT @limit
		`;

		const rows = this.db.prepare(sql).all(params) as Array<RawMessageSearchChunkRow & { bm25_rank: number }>;
		const childResults = this.hydrateLexicalChunkRows(rows, input).slice(0, limit);
		if (childResults.length >= limit) return childResults;
		const legacyResults = this.searchLegacyMessagesLexically(input, ftsQuery, limit).filter(
			(hit) => !this.messageHasSearchChunks(hit.id),
		);
		return [...childResults, ...legacyResults].sort((a, b) => a.bm25Rank - b.bm25Rank).slice(0, limit);
	}

	private searchChunksWithVectorTable(
		input: SQLiteRawMessageSemanticSearchInput,
	): SQLiteRawMessageSemanticSearchResult[] {
		const limit = Math.max(1, Math.floor(input.limit ?? 10));
		const scanLimit = Math.min(4096, Math.max(limit * 4, Math.floor(input.scanLimit ?? limit * 10)));
		const threshold = input.threshold ?? 0.7;
		const rows = this.db
			.prepare(`
        SELECT chunk_id, distance
        FROM ${this.getChildVectorTableName(input.queryEmbedding.length)}
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT ?
      `)
			.all(floatArrayToBuffer(input.queryEmbedding), scanLimit) as Array<{
			chunk_id: string;
			distance: number;
		}>;
		const distances = new Map(rows.map((row) => [row.chunk_id, row.distance]));
		const chunks = this.getSearchChunkRowsByIds(rows.map((row) => row.chunk_id));
		return this.hydrateSemanticChunkRows(
			chunks.map((chunk) => ({
				chunk,
				similarity: sqliteVectorDistanceToCosineSimilarity(
					distances.get(chunk.chunk_id) ?? Number.POSITIVE_INFINITY,
				),
			})),
			input,
		)
			.filter((result) => result.similarity >= threshold)
			.slice(0, limit);
	}

	private searchChunksWithStoredEmbeddings(
		input: SQLiteRawMessageSemanticSearchInput,
	): SQLiteRawMessageSemanticSearchResult[] {
		const limit = Math.max(1, Math.floor(input.limit ?? 10));
		const scanLimit = Math.max(limit * 4, Math.floor(input.scanLimit ?? limit * 10));
		const threshold = input.threshold ?? 0.7;
		const rows = this.db
			.prepare(`
        SELECT raw_message_chunks.*
        FROM raw_message_chunks
        JOIN raw_messages ON raw_messages.message_id = raw_message_chunks.message_id
        WHERE raw_message_chunks.user_id = @userId
          AND raw_message_chunks.embedding IS NOT NULL
          AND raw_message_chunks.embedding_dimensions = @dimensions
          ${input.includeArchived ? "" : "AND raw_messages.archived_at IS NULL"}
          ${input.includeDeprecated ? "" : "AND raw_messages.deprecated_at IS NULL"}
        ORDER BY raw_messages.timestamp DESC
        LIMIT @scanLimit
      `)
			.all({
				userId: input.userId,
				dimensions: input.queryEmbedding.length,
				scanLimit,
			}) as RawMessageSearchChunkRow[];
		return this.hydrateSemanticChunkRows(
			rows
				.filter(
					(row) =>
						!input.embeddingModel || !row.embedding_model || row.embedding_model === input.embeddingModel,
				)
				.map((chunk) => ({
					chunk,
					similarity: cosineSimilarity(
						input.queryEmbedding,
						bufferToFloatArray(chunk.embedding ?? Buffer.alloc(0)) ?? [],
					),
				})),
			input,
		)
			.filter((result) => Number.isFinite(result.similarity) && result.similarity >= threshold)
			.slice(0, limit);
	}

	private hydrateSemanticChunkRows(
		rows: Array<{ chunk: RawMessageSearchChunkRow; similarity: number }>,
		input: SQLiteRawMessageSemanticSearchInput,
	): SQLiteRawMessageSemanticSearchResult[] {
		const strongestByParent = new Map<string, { chunk: RawMessageSearchChunkRow; similarity: number }>();
		for (const row of rows.sort((a, b) => b.similarity - a.similarity)) {
			if (!strongestByParent.has(row.chunk.message_id)) strongestByParent.set(row.chunk.message_id, row);
		}
		const parents = new Map(
			this.getRowsByMessageIds([...strongestByParent.keys()]).map((row) => [
				row.message_id,
				toRawMessage(row),
			]),
		);
		return [...strongestByParent.values()]
			.map(({ chunk, similarity }) => {
				const message = parents.get(chunk.message_id);
				if (!message || !this.matchesSemanticFilters(message, { ...input, embeddingModel: undefined }))
					return null;
				return this.toChildSemanticSearchResult(message, chunk, similarity);
			})
			.filter((result): result is SQLiteRawMessageSemanticSearchResult => result !== null)
			.sort((a, b) => b.similarity - a.similarity);
	}

	private hydrateLexicalChunkRows(
		rows: Array<RawMessageSearchChunkRow & { bm25_rank: number }>,
		_input: SQLiteRawMessageLexicalSearchInput,
	): SQLiteRawMessageLexicalSearchResult[] {
		const strongestByParent = new Map<string, RawMessageSearchChunkRow & { bm25_rank: number }>();
		for (const row of rows) {
			if (!strongestByParent.has(row.message_id)) strongestByParent.set(row.message_id, row);
		}
		const parents = new Map(
			this.getRowsByMessageIds([...strongestByParent.keys()]).map((row) => [
				row.message_id,
				toRawMessage(row),
			]),
		);
		return [...strongestByParent.values()]
			.map((chunk) => {
				const message = parents.get(chunk.message_id);
				if (!message) return null;
				const content = this.searchResultContent(message, chunk);
				return {
					type: "memory" as const,
					id: message.messageId,
					content: message.archivedAt ? "" : content,
					similarity: sqliteDistanceToScore(-chunk.bm25_rank),
					bm25Rank: chunk.bm25_rank,
					metadata: {
						...(message.metadata ?? {}),
						userId: message.userId,
						platform: message.platform,
						botId: message.botId,
						channel: message.channel,
						person: message.person,
						timestamp: normalizeTimestampToMs(message.timestamp),
						memoryStage: message.memoryStage,
						factType: message.factType,
						scoring: "bm25" as const,
						sourceMessageId: message.messageId,
						sourceChunkId: chunk.chunk_id,
						sourceChunkIndex: chunk.chunk_index,
						sourceChunkCount: chunk.chunk_count,
					},
					message: { ...message, content },
				};
			})
			.filter(Boolean) as SQLiteRawMessageLexicalSearchResult[];
	}

	private toChildSemanticSearchResult(
		message: RawMessage,
		chunk: RawMessageSearchChunkRow,
		similarity: number,
	): SQLiteRawMessageSemanticSearchResult {
		const content = this.searchResultContent(message, chunk);
		return {
			type: "memory",
			id: message.messageId,
			content: message.archivedAt ? "" : content,
			similarity,
			metadata: {
				...(message.metadata ?? {}),
				userId: message.userId,
				platform: message.platform,
				botId: message.botId,
				channel: message.channel,
				person: message.person,
				timestamp: normalizeTimestampToMs(message.timestamp),
				memoryStage: message.memoryStage,
				embeddingModel: chunk.embedding_model ?? undefined,
				factType: message.factType,
				sourceMessageId: message.messageId,
				sourceChunkId: chunk.chunk_id,
				sourceChunkIndex: chunk.chunk_index,
				sourceChunkCount: chunk.chunk_count,
			},
			message: { ...message, content },
		};
	}

	private searchResultContent(message: RawMessage, hit: RawMessageSearchChunkRow): string {
		if (hit.chunk_count <= 1) return message.content;
		const window = this.db
			.prepare(`
        SELECT MIN(start_position) AS start_position, MAX(end_position) AS end_position
        FROM raw_message_chunks
        WHERE message_id = @messageId
          AND chunk_index BETWEEN @startIndex AND @endIndex
      `)
			.get({
				messageId: message.messageId,
				startIndex: Math.max(0, hit.chunk_index - 1),
				endIndex: Math.min(hit.chunk_count - 1, hit.chunk_index + 1),
			}) as { start_position: number | null; end_position: number | null };
		return message.content.slice(
			window.start_position ?? hit.start_position,
			window.end_position ?? hit.end_position,
		);
	}

	private getSearchChunkRowsByIds(chunkIds: string[]): RawMessageSearchChunkRow[] {
		const ids = Array.from(new Set(chunkIds.filter(Boolean)));
		if (ids.length === 0) return [];
		const params: Record<string, string> = {};
		const placeholders = ids.map((id, index) => {
			params[`id${index}`] = id;
			return `@id${index}`;
		});
		return this.db
			.prepare(`SELECT * FROM raw_message_chunks WHERE chunk_id IN (${placeholders.join(", ")})`)
			.all(params) as RawMessageSearchChunkRow[];
	}

	private messageHasSearchChunks(messageId: string): boolean {
		return Boolean(
			this.db.prepare("SELECT 1 FROM raw_message_chunks WHERE message_id = ? LIMIT 1").get(messageId),
		);
	}

	private searchLegacyMessagesLexically(
		input: SQLiteRawMessageLexicalSearchInput,
		ftsQuery: string,
		limit: number,
	): SQLiteRawMessageLexicalSearchResult[] {
		const rows = this.db
			.prepare(`
        SELECT raw_messages.*, raw_messages_fts.rank AS bm25_rank
        FROM raw_messages_fts, raw_messages
        WHERE raw_messages_fts MATCH @ftsQuery
          AND raw_messages.id = raw_messages_fts.rowid
          AND raw_messages.user_id = @userId
          AND NOT EXISTS (SELECT 1 FROM raw_message_chunks WHERE raw_message_chunks.message_id = raw_messages.message_id)
          ${input.includeArchived ? "" : "AND raw_messages.archived_at IS NULL"}
          ${input.includeDeprecated ? "" : "AND raw_messages.deprecated_at IS NULL"}
          ${input.platform ? "AND raw_messages.platform = @platform" : ""}
          ${input.botId ? "AND raw_messages.bot_id = @botId" : ""}
        ORDER BY bm25_rank ASC
        LIMIT @limit
      `)
			.all({ ftsQuery, userId: input.userId, platform: input.platform, botId: input.botId, limit }) as Array<
			RawMessageRow & { bm25_rank: number }
		>;
		return rows.map((row) => {
			const message = toRawMessage(row);
			return {
				type: "memory",
				id: message.messageId,
				content: message.content,
				similarity: sqliteDistanceToScore(-row.bm25_rank),
				bm25Rank: row.bm25_rank,
				metadata: {
					...(message.metadata ?? {}),
					userId: message.userId,
					platform: message.platform,
					botId: message.botId,
					channel: message.channel,
					person: message.person,
					timestamp: normalizeTimestampToMs(message.timestamp),
					memoryStage: message.memoryStage,
					factType: message.factType,
					scoring: "bm25",
				},
				message,
			};
		});
	}

	private initializeVectorSearch(): void {
		if (!this.enableVectorSearch) {
			return;
		}

		try {
			sqliteVec.load(this.db);
			this.vectorSearchAvailable = true;
			this.rebuildVectorTables();
		} catch (_error) {
			this.vectorSearchAvailable = false;
		}
	}

	/** Update sqlite-vec vector table for a message (called after embeddings are added/updated). */
	upsertVectorForMessage(messageId: string, embedding: number[] | undefined): void {
		if (!this.vectorSearchAvailable) {
			return;
		}

		this.deleteMessageFromVectorTables(messageId);

		if (!embedding || embedding.length === 0) {
			return;
		}

		this.ensureVectorTable(embedding.length);
		this.db
			.prepare(
				`
          INSERT INTO ${this.getVectorTableName(embedding.length)}
            (embedding, message_id)
          VALUES (?, ?)
        `,
			)
			.run(floatArrayToBuffer(embedding), messageId);
	}

	private upsertVectorForSearchChunk(chunkId: string, embedding: number[] | undefined): void {
		if (!this.vectorSearchAvailable) return;
		for (const tableName of this.listChildVectorTables()) {
			this.db.prepare(`DELETE FROM ${tableName} WHERE chunk_id = ?`).run(chunkId);
		}
		if (!embedding || embedding.length === 0 || embedding.every((value) => value === 0)) return;
		this.ensureChildVectorTable(embedding.length);
		this.db
			.prepare(
				`INSERT INTO ${this.getChildVectorTableName(embedding.length)} (embedding, chunk_id) VALUES (?, ?)`,
			)
			.run(floatArrayToBuffer(embedding), chunkId);
	}

	private rebuildVectorTables(): void {
		if (!this.vectorSearchAvailable) {
			return;
		}

		// The legacy table was fixed to one dimension. Dimension-specific tables
		// let embedding-model migrations coexist while dream reindexes old rows.
		this.db.exec("DROP TABLE IF EXISTS raw_messages_vec");
		for (const triggerName of this.listVectorDeleteTriggers()) {
			this.db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
		}
		for (const tableName of this.listVectorTables()) {
			this.db.exec(`DROP TABLE IF EXISTS ${tableName}`);
		}
		for (const triggerName of this.listChildVectorDeleteTriggers()) {
			this.db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
		}
		for (const tableName of this.listChildVectorTables()) {
			this.db.exec(`DROP TABLE IF EXISTS ${tableName}`);
		}

		const rows = this.db
			.prepare(
				`
          SELECT message_id, embedding, embedding_dimensions
          FROM raw_messages
          WHERE embedding IS NOT NULL
            AND embedding_dimensions IS NOT NULL
            AND embedding_dimensions > 0
        `,
			)
			.all() as Array<{
			message_id: string;
			embedding: Buffer;
			embedding_dimensions: number;
		}>;

		const insertMany = this.db.transaction(
			(
				items: Array<{
					message_id: string;
					embedding: Buffer;
					embedding_dimensions: number;
				}>,
			) => {
				for (const row of items) {
					if (row.embedding.length !== row.embedding_dimensions * 4) {
						continue;
					}
					this.ensureVectorTable(row.embedding_dimensions);
					this.db
						.prepare(
							`
                INSERT INTO ${this.getVectorTableName(row.embedding_dimensions)} (embedding, message_id)
                VALUES (?, ?)
              `,
						)
						.run(row.embedding, row.message_id);
				}
			},
		);
		insertMany(rows);

		const chunkRows = this.db
			.prepare(`
        SELECT chunk_id, embedding, embedding_dimensions
        FROM raw_message_chunks
        WHERE embedding IS NOT NULL
          AND embedding_dimensions IS NOT NULL
          AND embedding_dimensions > 0
      `)
			.all() as Array<{ chunk_id: string; embedding: Buffer; embedding_dimensions: number }>;
		const insertChunks = this.db.transaction(
			(items: Array<{ chunk_id: string; embedding: Buffer; embedding_dimensions: number }>) => {
				for (const row of items) {
					if (row.embedding.length !== row.embedding_dimensions * 4) continue;
					if ((bufferToFloatArray(row.embedding) ?? []).every((value) => value === 0)) continue;
					this.ensureChildVectorTable(row.embedding_dimensions);
					this.db
						.prepare(
							`INSERT INTO ${this.getChildVectorTableName(row.embedding_dimensions)} (embedding, chunk_id) VALUES (?, ?)`,
						)
						.run(row.embedding, row.chunk_id);
				}
			},
		);
		insertChunks(chunkRows);
	}

	private clearVectorTable(): void {
		if (!this.vectorSearchAvailable) {
			return;
		}
		for (const tableName of this.listVectorTables()) {
			this.db.prepare(`DELETE FROM ${tableName}`).run();
		}
	}

	private clearChildVectorTables(): void {
		if (!this.vectorSearchAvailable) return;
		for (const tableName of this.listChildVectorTables()) {
			this.db.prepare(`DELETE FROM ${tableName}`).run();
		}
	}

	private ensureVectorTable(dimensions: number): void {
		const tableName = this.getVectorTableName(dimensions);
		this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName}
      USING vec0(
        embedding float[${dimensions}],
        message_id TEXT PRIMARY KEY
      );

      -- vec0 virtual tables cannot declare a foreign key, so keep direct SQL
      -- deletes consistent with the source table through a dimension trigger.
      CREATE TRIGGER IF NOT EXISTS ${this.getVectorDeleteTriggerName(dimensions)}
      AFTER DELETE ON raw_messages
      BEGIN
        DELETE FROM ${tableName} WHERE message_id = OLD.message_id;
      END;
    `);
	}

	private ensureChildVectorTable(dimensions: number): void {
		const tableName = this.getChildVectorTableName(dimensions);
		this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName}
      USING vec0(
        embedding float[${dimensions}],
        chunk_id TEXT PRIMARY KEY
      );

      CREATE TRIGGER IF NOT EXISTS ${this.getChildVectorDeleteTriggerName(dimensions)}
      AFTER DELETE ON raw_message_chunks
      BEGIN
        DELETE FROM ${tableName} WHERE chunk_id = OLD.chunk_id;
      END;
    `);
	}

	private vectorTableExists(dimensions: number): boolean {
		return Boolean(
			this.db
				.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
				.get(this.getVectorTableName(dimensions)),
		);
	}

	private childVectorTableExists(dimensions: number): boolean {
		return this.tableExists(this.getChildVectorTableName(dimensions));
	}

	private tableExists(name: string): boolean {
		return Boolean(
			this.db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?").get(name),
		);
	}

	private getVectorTableName(dimensions: number): string {
		if (!Number.isInteger(dimensions) || dimensions <= 0) {
			throw new Error(`Invalid raw message embedding dimensions: ${dimensions}`);
		}
		return `raw_messages_vec_d${dimensions}`;
	}

	private getChildVectorTableName(dimensions: number): string {
		if (!Number.isInteger(dimensions) || dimensions <= 0) {
			throw new Error(`Invalid raw message child embedding dimensions: ${dimensions}`);
		}
		return `raw_message_chunks_vec_d${dimensions}`;
	}

	private getVectorDeleteTriggerName(dimensions: number): string {
		return `${this.getVectorTableName(dimensions)}_delete`;
	}

	private getChildVectorDeleteTriggerName(dimensions: number): string {
		return `${this.getChildVectorTableName(dimensions)}_delete`;
	}

	private listVectorTables(): string[] {
		return (
			this.db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'raw_messages_vec_d%'")
				.all() as Array<{ name: string }>
		)
			.map((row) => row.name)
			.filter((name) => /^raw_messages_vec_d\d+$/.test(name));
	}

	private listVectorDeleteTriggers(): string[] {
		return (
			this.db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'raw_messages_vec_d%_delete'",
				)
				.all() as Array<{ name: string }>
		)
			.map((row) => row.name)
			.filter((name) => /^raw_messages_vec_d\d+_delete$/.test(name));
	}

	private listChildVectorTables(): string[] {
		return (
			this.db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'raw_message_chunks_vec_d%'",
				)
				.all() as Array<{ name: string }>
		)
			.map((row) => row.name)
			.filter((name) => /^raw_message_chunks_vec_d\d+$/.test(name));
	}

	private listChildVectorDeleteTriggers(): string[] {
		return (
			this.db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'raw_message_chunks_vec_d%_delete'",
				)
				.all() as Array<{ name: string }>
		)
			.map((row) => row.name)
			.filter((name) => /^raw_message_chunks_vec_d\d+_delete$/.test(name));
	}

	private deleteMessageFromVectorTables(messageId: string): void {
		for (const tableName of this.listVectorTables()) {
			this.db.prepare(`DELETE FROM ${tableName} WHERE message_id = ?`).run(messageId);
		}
	}

	private searchMessagesWithVectorTable(
		input: SQLiteRawMessageSemanticSearchInput,
	): SQLiteRawMessageSemanticSearchResult[] {
		const limit = Math.max(1, Math.floor(input.limit ?? 10));
		const scanLimit = Math.max(limit, Math.floor(input.scanLimit ?? limit * 10));
		const threshold = input.threshold ?? 0.7;
		// sqlite-vec rejects knn queries with k > 4096 ("k value in knn query
		// too large"), so the widening scan must stop there instead of
		// doubling past the engine limit and throwing.
		const vecKnnMaxK = 4096;
		let currentScanLimit = scanLimit;
		while (true) {
			const rows = this.db
				.prepare(
					`
            SELECT message_id, distance
            FROM ${this.getVectorTableName(input.queryEmbedding.length)}
            WHERE embedding MATCH ?
            ORDER BY distance
            LIMIT ?
          `,
				)
				.all(floatArrayToBuffer(input.queryEmbedding), currentScanLimit) as Array<{
				message_id: string;
				distance: number;
			}>;

			const byDistance = new Map(rows.map((row) => [row.message_id, row.distance]));
			const results = this.getRowsByMessageIds(rows.map((row) => row.message_id))
				.map(toRawMessage)
				.filter((message) => this.matchesSemanticFilters(message, input))
				.map((message) =>
					this.toSemanticSearchResult(
						message,
						sqliteVectorDistanceToCosineSimilarity(
							byDistance.get(message.messageId) ?? Number.POSITIVE_INFINITY,
						),
					),
				)
				.filter(
					(result): result is SQLiteRawMessageSemanticSearchResult =>
						result !== null && result.similarity >= threshold,
				)
				.sort((a, b) => b.similarity - a.similarity);

			if (results.length >= limit || rows.length < currentScanLimit) {
				return results.slice(0, limit);
			}
			if (currentScanLimit >= vecKnnMaxK) {
				return results.slice(0, limit);
			}
			currentScanLimit = Math.min(currentScanLimit * 2, vecKnnMaxK);
		}
	}

	private searchMessagesWithStoredEmbeddings(
		input: SQLiteRawMessageSemanticSearchInput,
	): SQLiteRawMessageSemanticSearchResult[] {
		const limit = Math.max(1, Math.floor(input.limit ?? 10));
		const scanLimit = Math.max(limit, Math.floor(input.scanLimit ?? limit * 10));
		const threshold = input.threshold ?? 0.7;

		return this.queryMessagesSync({
			userId: input.userId,
			includeArchived: input.includeArchived ?? false,
			includeDeprecated: input.includeDeprecated ?? false,
			reverse: true,
			pageSize: scanLimit,
			platform: input.platform,
			botId: input.botId,
			channel: input.channel,
			person: input.person,
			startTime: input.startTime,
			endTime: input.endTime,
		})
			.map((message) => {
				if (!message.embedding || message.embedding.length === 0) {
					return null;
				}
				if (
					input.embeddingModel &&
					message.embeddingModel &&
					message.embeddingModel !== input.embeddingModel
				) {
					return null;
				}
				const similarity = cosineSimilarity(input.queryEmbedding, message.embedding);
				return this.toSemanticSearchResult(message, similarity);
			})
			.filter(
				(result): result is SQLiteRawMessageSemanticSearchResult =>
					result !== null && Number.isFinite(result.similarity) && result.similarity >= threshold,
			)
			.sort((a, b) => b.similarity - a.similarity)
			.slice(0, limit);
	}

	private matchesSemanticFilters(message: RawMessage, input: SQLiteRawMessageSemanticSearchInput): boolean {
		if (message.userId !== input.userId) {
			return false;
		}
		if (!input.includeArchived && message.archivedAt !== undefined) {
			return false;
		}
		if (!input.includeDeprecated && message.deprecatedAt !== undefined) {
			return false;
		}
		if (input.embeddingModel && message.embeddingModel !== input.embeddingModel) {
			return false;
		}
		if (input.platform && message.platform !== input.platform) {
			return false;
		}
		if (input.botId && message.botId !== input.botId) {
			return false;
		}
		if (input.channel && !message.channel?.toLowerCase().includes(input.channel.toLowerCase())) {
			return false;
		}
		if (input.person && !message.person?.toLowerCase().includes(input.person.toLowerCase())) {
			return false;
		}
		if (input.startTime !== undefined && message.timestamp < input.startTime) {
			return false;
		}
		if (input.endTime !== undefined && message.timestamp >= input.endTime) {
			return false;
		}
		if (
			input.factTypes &&
			input.factTypes.length > 0 &&
			(message.factType === undefined || !input.factTypes.includes(message.factType))
		) {
			return false;
		}
		return true;
	}

	private toSemanticSearchResult(
		message: RawMessage,
		similarity: number,
	): SQLiteRawMessageSemanticSearchResult | null {
		if (!Number.isFinite(similarity)) {
			return null;
		}

		return {
			type: "memory",
			id: message.messageId,
			content: message.archivedAt ? "" : message.content,
			similarity,
			metadata: {
				...(message.metadata ?? {}),
				userId: message.userId,
				platform: message.platform,
				botId: message.botId,
				channel: message.channel,
				person: message.person,
				timestamp: normalizeTimestampToMs(message.timestamp),
				memoryStage: message.memoryStage,
				embeddingModel: message.embeddingModel,
				factType: message.factType,
			},
			message,
		};
	}

	private queryMessagesSync(query: RawMessageQuery): RawMessage[] {
		const where: string[] = [];
		const params: Record<string, unknown> = {};

		if (query.userId) {
			where.push("user_id = @userId");
			params.userId = query.userId;
		}
		if (query.platform) {
			where.push("platform = @platform");
			params.platform = query.platform;
		}
		if (query.botId) {
			where.push("bot_id = @botId");
			params.botId = query.botId;
		}
		if (query.channel) {
			where.push("lower(coalesce(channel, '')) LIKE @channel ESCAPE '\\'");
			params.channel = `%${escapeLike(query.channel.toLowerCase())}%`;
		}
		if (query.person) {
			where.push("lower(coalesce(person, '')) LIKE @person ESCAPE '\\'");
			params.person = `%${escapeLike(query.person.toLowerCase())}%`;
		}
		if (query.startTime !== undefined) {
			where.push("timestamp >= @startTime");
			params.startTime = query.startTime;
		}
		if (query.endTime !== undefined) {
			where.push("timestamp < @endTime");
			params.endTime = query.endTime;
		}
		if (!query.includeArchived) {
			where.push("archived_at IS NULL");
		}
		if (!query.includeDeprecated) {
			// Soft-hide deprecated records by default. Backed by the partial index
			// `idx_raw_messages_active_user` (`WHERE deprecated_at IS NULL`).
			where.push("deprecated_at IS NULL");
		}

		const order = query.reverse ? "DESC" : "ASC";
		params.limit = query.pageSize ?? query.limit ?? 50;
		params.offset = query.offset ?? 0;

		return (
			this.db
				.prepare(
					`
            SELECT *
            FROM raw_messages
            ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
            ORDER BY timestamp ${order}, id ${order}
            LIMIT @limit OFFSET @offset
          `,
				)
				.all(params) as RawMessageRow[]
		).map(toRawMessage);
	}

	private getRowsByMessageIds(messageIds: string[], userId?: string): RawMessageRow[] {
		const ids = Array.from(new Set(messageIds.filter(Boolean)));
		if (ids.length === 0) {
			return [];
		}
		const params: Record<string, unknown> = {};
		const placeholders = ids
			.map((id, index) => {
				params[`id${index}`] = id;
				return `@id${index}`;
			})
			.join(", ");
		if (userId) {
			params.userId = userId;
		}
		return this.db
			.prepare(
				`
          SELECT *
          FROM raw_messages
          WHERE message_id IN (${placeholders})
          ${userId ? "AND user_id = @userId" : ""}
        `,
			)
			.all(params) as RawMessageRow[];
	}

	private updateMessagesByMessageIds(
		messageIds: string[],
		setSql: string,
		params: Record<string, unknown>,
		userId?: string,
	): number {
		const ids = Array.from(new Set(messageIds.filter(Boolean)));
		if (ids.length === 0) {
			return 0;
		}
		const queryParams = { ...params } as Record<string, unknown>;
		const placeholders = ids
			.map((id, index) => {
				queryParams[`id${index}`] = id;
				return `@id${index}`;
			})
			.join(", ");
		if (userId) {
			queryParams.userId = userId;
		}
		const result = this.db
			.prepare(
				`
          UPDATE raw_messages
          SET ${setSql}
          WHERE message_id IN (${placeholders})
          ${userId ? "AND user_id = @userId" : ""}
        `,
			)
			.run(queryParams);
		return result.changes;
	}
}
