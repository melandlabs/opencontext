/**
 * Memory-store contracts — types and constants that were originally re-exported
 * from `@melandlabs/indexeddb` but pulled in browser-only code (IndexedDB
 * globals) at module evaluation time, breaking the standalone HTTP/MCP
 * daemons.
 *
 * Anything defined here can be safely imported on the server without any
 * browser globals being resolved. The `@melandlabs/indexeddb` peer dependency
 * is optional in `@melandlabs/memory-store/package.json`; consumers can
 * depend on it directly for IndexedDB-backed storage.
 *
 * Re-export from this module is stable. New domain types belong in
 * dedicated files; this module only hosts the boundary contracts.
 */

import type { MemoryRecord } from "@melandlabs/ai/memory";

/** Prefix used to reserve chat-memory evidence IDs that must not collide. */
export const CHAT_MEMORY_EVIDENCE_ID_PREFIX = "opencontext-chat:";

/** A locally-defined re-export of the raw-message shape used by the SDK.
 * Kept as a structural type so consumers (SQLite, postgres factories)
 * can pass either the IndexedDB `RawMessage` or this shape. */
export interface RawMessage {
	id?: number;
	messageId: string;
	platform: string;
	botId: string;
	userId: string;
	channel?: string;
	person?: string;
	timestamp: number;
	content: string;
	attachments?: Array<{
		name: string;
		url: string;
		contentType?: string;
		sizeBytes?: number;
	}>;
	embedding?: number[];
	embeddingModel?: string;
	embeddingContentHash?: string;
	embeddingDimensions?: number;
	embeddingUpdatedAt?: number;
	// biome-ignore lint/suspicious/noExplicitAny: Preserve the public raw metadata contract.
	metadata?: Record<string, any>;
	createdAt: number;
	memoryStage?: "short" | "mid" | "long";
	accessCount?: number;
	lastAccessAt?: number;
	importanceScore?: number;
	archivedAt?: number;
	isPinned?: boolean;
	summaryRefId?: string;
	deprecatedAt?: number;
	deprecationReason?: string;
	supersededBySummaryId?: string;
	/**
	 * Optional back-pointer to the originating {@link Episode} envelope. When
	 * ingest adapters group raw messages by transcript / meeting / voice memo
	 * the episode id is recorded here so that downstream retrieval can lift
	 * whole episodes atomically.
	 */
	sourceEpisodeId?: string;
}

function normalizeTimestampToMs(value: number | undefined): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	if ((value as number) < 1e11) {
		return Math.floor((value as number) * 1000);
	}
	return Math.floor(value as number);
}

/** Convert a RawMessage to a MemoryRecord for embedding. Local copy of the
 * helper that previously lived in `@melandlabs/indexeddb/embedding` and pulled
 * in browser-only modules. */
export function rawMessageToMemoryRecord(message: RawMessage): MemoryRecord {
	return {
		id: message.messageId,
		userId: message.userId,
		timestamp: normalizeTimestampToMs(message.timestamp),
		text: message.archivedAt ? undefined : message.content,
		mediaRefs: message.attachments?.map((item) => item.url).filter(Boolean),
		embedding: message.embedding,
		embeddingModel: message.embeddingModel,
		embeddingContentHash: message.embeddingContentHash,
	} as unknown as MemoryRecord;
}

// ───────────────────────────────────────────────────────────────────────────
// Vector Symbolic Architecture (VSA) — independent verb, not unified-search.
//
// VSA facts are (role, filler) bindings stored as Float32 vectors, recalled
// by `unbind(role) → cleanup(vocabulary)`. They live in their own storage
// layer (see `@melandlabs/sqlite/sqlite-vsa-store`) and are never surfaced
// through `search()` because the recall semantics are different
// (single best-match, not top-K nearest neighbours).
//
// Vocabulary ownership: the caller owns the (label → vector) mapping for
// both roles and fillers. The store only persists the vectors used at
// store time so the role used at recall time exactly matches the one bound
// at store time, even if the caller later changes their role registry.
//
// The shapes live in `@melandlabs/contracts/vsa-fact` so both
// `@melandlabs/sqlite` (the storage impl) and `@melandlabs/memory-store`
// (the SDK wrapper) can share them without creating a runtime cycle.
// ───────────────────────────────────────────────────────────────────────────

export type {
	VsaFact,
	VsaFactSummary,
	StoreVsaFactInput,
	StoreVsaFactOutput,
	VsaVocabularyEntry,
	VsaRecallInput,
	VsaRecallOutput,
	VsaRecallScore,
	VsaListInput,
	VsaForgetInput,
	VsaForgetOutput,
	VsaFactStorage,
} from "@melandlabs/contracts";
export { vsaNormalizeVector, vsaAssertSameDim } from "@melandlabs/contracts";
