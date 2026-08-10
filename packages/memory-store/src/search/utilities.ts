/**
 * Pure helpers used by the unified memory search pipeline.
 *
 * Kept side-effect free so they can be reused by tests, MCP tools,
 * and the HTTP daemon without pulling in any of the heavier
 * storage/search implementations.
 */

export type UnifiedMemorySearchSource = "memory" | "insights" | "knowledge";

export interface UnifiedMemorySearchWarning {
	source: UnifiedMemorySearchSource;
	code: string;
	message: string;
}

export interface UnifiedMemorySearchInput {
	userId: string;
	query: string;
	sources?: UnifiedMemorySearchSource[];
	limit?: number;
	threshold?: number;
	authToken?: string;
	includeArchivedInsights?: boolean;
	botIds?: string[];
	documentIds?: string[];
}

export interface UnifiedMemorySearchResult {
	type: "memory" | "insight" | "knowledge";
	id: string;
	content: string;
	similarity: number;
	metadata: Record<string, unknown>;
}

export interface UnifiedMemorySearchOutput {
	query: string;
	sources: UnifiedMemorySearchSource[];
	results: UnifiedMemorySearchResult[];
	count: number;
	warnings: UnifiedMemorySearchWarning[];
}

const DEFAULT_LIMIT = 10;
const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_SOURCES: UnifiedMemorySearchSource[] = [
	"memory",
	"insights",
	"knowledge",
];
const SOURCE_SET = new Set<UnifiedMemorySearchSource>(DEFAULT_SOURCES);

export function normalizeUnifiedMemorySearchSources(
	sources: unknown,
): UnifiedMemorySearchSource[] {
	if (!Array.isArray(sources) || sources.length === 0) {
		return [...DEFAULT_SOURCES];
	}

	const normalized = sources
		.filter((source): source is string => typeof source === "string")
		.map((source) => source.trim().toLowerCase())
		.filter((source): source is UnifiedMemorySearchSource =>
			SOURCE_SET.has(source as UnifiedMemorySearchSource),
		);

	return normalized.length > 0
		? Array.from(new Set(normalized))
		: [...DEFAULT_SOURCES];
}

export function clampUnifiedMemorySearchLimit(limit: unknown): number {
	const parsed =
		typeof limit === "number" ? limit : Number(limit ?? DEFAULT_LIMIT);
	if (!Number.isFinite(parsed)) {
		return DEFAULT_LIMIT;
	}
	return Math.min(50, Math.max(1, Math.floor(parsed)));
}

export function clampUnifiedMemorySearchThreshold(threshold: unknown): number {
	const parsed =
		typeof threshold === "number"
			? threshold
			: Number(threshold ?? DEFAULT_THRESHOLD);
	if (!Number.isFinite(parsed)) {
		return DEFAULT_THRESHOLD;
	}
	return Math.min(1, Math.max(-1, parsed));
}

export function mergeUnifiedMemorySearchResults(
	results: UnifiedMemorySearchResult[],
	limit: number,
): UnifiedMemorySearchResult[] {
	return [...results]
		.sort((a, b) => {
			const scoreDelta = b.similarity - a.similarity;
			if (scoreDelta !== 0) {
				return scoreDelta;
			}
			return a.type.localeCompare(b.type) || a.id.localeCompare(b.id);
		})
		.slice(0, limit);
}

export function toKnowledgeResult(result: {
	chunkId: string;
	documentId: string;
	documentName: string;
	content: string;
	similarity: number;
	chunkIndex: number;
}): UnifiedMemorySearchResult {
	return {
		type: "knowledge",
		id: result.chunkId,
		content: result.content,
		similarity: result.similarity,
		metadata: {
			documentId: result.documentId,
			documentName: result.documentName,
			chunkIndex: result.chunkIndex,
		},
	};
}

export function toMemoryResult(result: {
	id: string;
	content: string;
	similarity: number;
	metadata: Record<string, unknown>;
}): UnifiedMemorySearchResult {
	return {
		type: "memory",
		id: result.id,
		content: result.content,
		similarity: result.similarity,
		metadata: result.metadata,
	};
}

export function isRawMemorySemanticResult(result: unknown): result is {
	id: string;
	content: string;
	similarity: number;
	metadata: Record<string, unknown>;
} {
	if (!result || typeof result !== "object") {
		return false;
	}
	const item = result as Record<string, unknown>;
	return (
		typeof item.id === "string" &&
		typeof item.content === "string" &&
		typeof item.similarity === "number" &&
		Boolean(item.metadata) &&
		typeof item.metadata === "object"
	);
}
