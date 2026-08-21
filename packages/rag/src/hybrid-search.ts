import type {
	DocumentChunk,
	HybridSearchFilter,
	HybridSearchQuery,
	IHybridVectorStore,
	IVectorStore,
	VectorSearchResult,
} from "./vector-service";

export interface HybridFusionInput {
	dense: VectorSearchResult[];
	lexical: VectorSearchResult[];
	strategy?: "rrf" | "weighted";
	alpha?: number;
	rrfK?: number;
	limit?: number;
}

export interface LexicalSearchProvider {
	search(query: string, limit: number, filter?: HybridSearchFilter): Promise<VectorSearchResult[]>;
}

export interface HybridSearchAdapterOptions {
	vectorStore: IVectorStore;
	lexicalSearch: LexicalSearchProvider;
	defaultFusion?: "rrf" | "weighted";
	defaultAlpha?: number;
	defaultRrfK?: number;
	candidateMultiplier?: number;
}

interface FusedCandidate {
	result: VectorSearchResult;
	score: number;
	bestRank: number;
}

const DEFAULT_LIMIT = 10;
const DEFAULT_ALPHA = 0.5;
const DEFAULT_RRF_K = 60;
const DEFAULT_CANDIDATE_MULTIPLIER = 4;

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
	const resolved = value ?? fallback;
	if (!Number.isInteger(resolved) || resolved <= 0) {
		throw new RangeError(`${name} must be a positive integer`);
	}
	return resolved;
}

function unitInterval(value: number | undefined, fallback: number, name: string): number {
	const resolved = value ?? fallback;
	if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1) {
		throw new RangeError(`${name} must be between 0 and 1`);
	}
	return resolved;
}

function uniqueRanked(results: VectorSearchResult[]): VectorSearchResult[] {
	const seen = new Set<string>();
	return results.filter((result) => {
		if (seen.has(result.id)) return false;
		seen.add(result.id);
		return true;
	});
}

function normalizedScores(results: VectorSearchResult[]): Map<string, number> {
	const unique = uniqueRanked(results);
	if (unique.length === 0) return new Map();

	const finiteScores = unique.map((result) => result.score).filter(Number.isFinite);
	if (finiteScores.length === 0) {
		return new Map(unique.map((result) => [result.id, 0]));
	}

	const min = Math.min(...finiteScores);
	const max = Math.max(...finiteScores);
	if (min === max) {
		return new Map(unique.map((result) => [result.id, 1]));
	}

	return new Map(
		unique.map((result) => [
			result.id,
			Number.isFinite(result.score) ? (result.score - min) / (max - min) : 0,
		]),
	);
}

function addCandidate(
	candidates: Map<string, FusedCandidate>,
	result: VectorSearchResult,
	score: number,
	rank: number,
): void {
	const current = candidates.get(result.id);
	if (current) {
		current.score += score;
		current.bestRank = Math.min(current.bestRank, rank);
		return;
	}

	candidates.set(result.id, {
		result,
		score,
		bestRank: rank,
	});
}

/**
 * Fuse already-ranked dense and lexical results. Weighted fusion min-max
 * normalizes each branch first so cosine/IP and BM25 scores are comparable.
 */
export function fuseHybridResults(input: HybridFusionInput): VectorSearchResult[] {
	const strategy = input.strategy ?? "rrf";
	const limit = positiveInteger(input.limit, DEFAULT_LIMIT, "limit");
	const dense = uniqueRanked(input.dense);
	const lexical = uniqueRanked(input.lexical);
	const candidates = new Map<string, FusedCandidate>();

	if (strategy === "rrf") {
		const rrfK = positiveInteger(input.rrfK, DEFAULT_RRF_K, "rrfK");
		for (const [index, result] of dense.entries()) {
			addCandidate(candidates, result, 1 / (rrfK + index + 1), index + 1);
		}
		for (const [index, result] of lexical.entries()) {
			addCandidate(candidates, result, 1 / (rrfK + index + 1), index + 1);
		}
	} else if (strategy === "weighted") {
		const alpha = unitInterval(input.alpha, DEFAULT_ALPHA, "alpha");
		const denseScores = normalizedScores(dense);
		const lexicalScores = normalizedScores(lexical);

		for (const [index, result] of dense.entries()) {
			addCandidate(candidates, result, alpha * (denseScores.get(result.id) ?? 0), index + 1);
		}
		for (const [index, result] of lexical.entries()) {
			addCandidate(candidates, result, (1 - alpha) * (lexicalScores.get(result.id) ?? 0), index + 1);
		}
	} else {
		throw new RangeError(`Unsupported hybrid fusion strategy: ${strategy satisfies never}`);
	}

	return [...candidates.values()]
		.sort((left, right) => {
			if (right.score !== left.score) return right.score - left.score;
			if (left.bestRank !== right.bestRank) return left.bestRank - right.bestRank;
			return left.result.id.localeCompare(right.result.id);
		})
		.slice(0, limit)
		.map(({ result, score }) => ({ ...result, score }));
}

function applyDocumentFilter(
	results: VectorSearchResult[],
	filter: HybridSearchFilter | undefined,
): VectorSearchResult[] {
	if (!filter?.documentIds?.length) return results;
	const allowed = new Set(filter.documentIds);
	return results.filter((result) => allowed.has(result.documentId));
}

/**
 * Adds hybrid retrieval to any existing vector store by pairing it with a
 * lexical provider. Storage operations remain delegated to the vector store.
 */
export class HybridSearchAdapter implements IHybridVectorStore {
	private readonly vectorStore: IVectorStore;
	private readonly lexicalSearch: LexicalSearchProvider;
	private readonly defaultFusion: "rrf" | "weighted";
	private readonly defaultAlpha: number;
	private readonly defaultRrfK: number;
	private readonly candidateMultiplier: number;

	constructor(options: HybridSearchAdapterOptions) {
		this.vectorStore = options.vectorStore;
		this.lexicalSearch = options.lexicalSearch;
		this.defaultFusion = options.defaultFusion ?? "rrf";
		this.defaultAlpha = unitInterval(options.defaultAlpha, DEFAULT_ALPHA, "defaultAlpha");
		this.defaultRrfK = positiveInteger(options.defaultRrfK, DEFAULT_RRF_K, "defaultRrfK");
		this.candidateMultiplier = positiveInteger(
			options.candidateMultiplier,
			DEFAULT_CANDIDATE_MULTIPLIER,
			"candidateMultiplier",
		);
	}

	addChunk(chunk: DocumentChunk): Promise<void> {
		return this.vectorStore.addChunk(chunk);
	}

	addChunks(chunks: DocumentChunk[]): Promise<void> {
		return this.vectorStore.addChunks(chunks);
	}

	similaritySearch(queryEmbedding: number[], limit?: number, userId?: string): Promise<VectorSearchResult[]> {
		return this.vectorStore.similaritySearch(queryEmbedding, limit, userId);
	}

	async hybridSearch(query: HybridSearchQuery): Promise<VectorSearchResult[]> {
		const limit = positiveInteger(query.limit, DEFAULT_LIMIT, "limit");
		const candidateLimit = positiveInteger(
			query.candidateLimit,
			limit * this.candidateMultiplier,
			"candidateLimit",
		);
		const text = query.text.trim();
		if (!text && !query.vector?.length) return [];

		const [dense, lexical] = await Promise.all([
			query.vector?.length
				? this.vectorStore.similaritySearch(query.vector, candidateLimit, query.filter?.userId)
				: Promise.resolve([]),
			text ? this.lexicalSearch.search(text, candidateLimit, query.filter) : Promise.resolve([]),
		]);

		return fuseHybridResults({
			dense: applyDocumentFilter(dense, query.filter),
			lexical: applyDocumentFilter(lexical, query.filter),
			strategy: query.fusion ?? this.defaultFusion,
			alpha: query.alpha ?? this.defaultAlpha,
			rrfK: query.rrfK ?? this.defaultRrfK,
			limit,
		});
	}

	deleteDocument(documentId: string): Promise<void> {
		return this.vectorStore.deleteDocument(documentId);
	}

	getDocumentCount(): Promise<number> {
		return this.vectorStore.getDocumentCount();
	}

	getChunkCount(): Promise<number> {
		return this.vectorStore.getChunkCount();
	}

	clear(): Promise<void> {
		return this.vectorStore.clear();
	}
}
