import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { chunkTextByTokenBudget } from "@melandlabs/shared";

const DEFAULT_LOCAL_RERANKER_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";
const DEFAULT_LOCAL_RERANKER_CACHE_DIR = path.join(os.homedir(), ".cache", "opencontext", "local-reranker");
const DEFAULT_LOCAL_RERANKER_BATCH_SIZE = 8;
const DEFAULT_LOCAL_RERANKER_MAX_TOKENS = 512;

interface RerankerCandidate {
	id: string;
	content: string;
	metadata?: Record<string, unknown>;
}

interface RerankerInput {
	query: string;
	candidates: RerankerCandidate[];
	topK?: number;
}

interface RerankerScore {
	id: string;
	score: number;
	evidenceScores?: Array<{
		sourceChunkId?: string;
		startPosition?: number;
		endPosition?: number;
		contentSha256: string;
		score: number;
		inputTokens: number;
		queryTruncated: boolean;
	}>;
}

interface TensorLike {
	data: ArrayLike<number>;
	dims?: number[];
}

type Tokenizer = ((
	texts: string[],
	options: {
		text_pair: string[];
		padding: boolean;
		truncation: boolean;
		max_length: number;
	},
) => Record<string, unknown>) & {
	encode(text: string, options: { text_pair?: string; add_special_tokens: boolean }): number[];
};

type SequenceClassificationModel = (inputs: Record<string, unknown>) => Promise<{ logits: TensorLike }>;

interface TransformersRerankerRuntime {
	env: { cacheDir: string; remoteHost: string };
	AutoTokenizer: {
		from_pretrained(model: string, options: Record<string, unknown>): Promise<Tokenizer>;
	};
	AutoModelForSequenceClassification: {
		from_pretrained(model: string, options: Record<string, unknown>): Promise<SequenceClassificationModel>;
	};
}

type RuntimeLoader = () => Promise<TransformersRerankerRuntime>;

async function loadTransformersRuntime(): Promise<TransformersRerankerRuntime> {
	const transformers = await import("@huggingface/transformers");
	return {
		env: transformers.env,
		AutoTokenizer: transformers.AutoTokenizer as unknown as TransformersRerankerRuntime["AutoTokenizer"],
		AutoModelForSequenceClassification:
			transformers.AutoModelForSequenceClassification as unknown as TransformersRerankerRuntime["AutoModelForSequenceClassification"],
	};
}

export interface LocalTransformersRerankerOptions {
	modelName?: string;
	batchSize?: number;
	cacheDir?: string;
	remoteHost?: string;
	device?: string;
	dtype?: string;
	localFilesOnly?: boolean;
	maxTokens?: number;
	/** Opt-in hit-centered scoring; expanded windows remain available to answerers. */
	candidateMode?: "window" | "matched-chunks";
	/** Test seam for the otherwise lazy dynamic Transformers.js import. */
	runtimeLoader?: RuntimeLoader;
}

/**
 * Local cross-encoder reranker backed by Transformers.js.
 *
 * The query and candidate are tokenized as a sequence pair and scored by a
 * sequence-classification model. Raw logits are sufficient because only their
 * relative order is used. The implementation is structurally compatible with
 * memory-store's `Reranker` contract without creating a package dependency
 * from ai-rag back to memory-store.
 */
export class LocalTransformersReranker {
	private readonly modelName: string;
	private readonly batchSize: number;
	private readonly cacheDir: string;
	private readonly remoteHost?: string;
	private readonly device?: string;
	private readonly dtype?: string;
	private readonly localFilesOnly: boolean;
	private readonly maxTokens: number;
	private readonly candidateMode: "window" | "matched-chunks";
	private readonly runtimeLoader: RuntimeLoader;
	private componentsPromise?: Promise<{ tokenizer: Tokenizer; model: SequenceClassificationModel }>;

	constructor(options: LocalTransformersRerankerOptions = {}) {
		this.modelName = options.modelName || process.env.LOCAL_RERANKER_MODEL || DEFAULT_LOCAL_RERANKER_MODEL;
		this.batchSize = positiveInteger(
			options.batchSize ??
				readPositiveInteger("LOCAL_RERANKER_BATCH_SIZE", DEFAULT_LOCAL_RERANKER_BATCH_SIZE),
			"batchSize",
		);
		this.cacheDir =
			options.cacheDir || process.env.LOCAL_RERANKER_CACHE_DIR || DEFAULT_LOCAL_RERANKER_CACHE_DIR;
		this.remoteHost = options.remoteHost || process.env.LOCAL_RERANKER_REMOTE_HOST || undefined;
		this.device = options.device || process.env.LOCAL_RERANKER_DEVICE || undefined;
		this.dtype = options.dtype || process.env.LOCAL_RERANKER_DTYPE || undefined;
		this.localFilesOnly = options.localFilesOnly ?? process.env.LOCAL_RERANKER_LOCAL_ONLY === "true";
		this.maxTokens = positiveInteger(
			options.maxTokens ??
				readPositiveInteger("LOCAL_RERANKER_MAX_TOKENS", DEFAULT_LOCAL_RERANKER_MAX_TOKENS),
			"maxTokens",
		);
		this.runtimeLoader = options.runtimeLoader ?? loadTransformersRuntime;
		this.candidateMode = options.candidateMode ?? "window";
		if (!["window", "matched-chunks"].includes(this.candidateMode))
			throw new Error("Unknown reranker candidate mode");
	}

	getModelName(): string {
		return this.modelName;
	}

	getCacheDir(): string {
		return this.cacheDir;
	}

	getMaxTokens(): number {
		return this.maxTokens;
	}

	/** Download/load the model and execute one real pair before serving traffic. */
	async warmup(): Promise<void> {
		await this.rerank({
			query: "Which document answers the question?",
			candidates: [{ id: "warmup", content: "This document answers the question." }],
			topK: 1,
		});
	}

	async rerank(input: RerankerInput): Promise<RerankerScore[]> {
		if (input.candidates.length === 0) return [];
		const { tokenizer, model } = await this.getComponents();
		if (this.candidateMode === "matched-chunks") return this.rerankMatchedChunks(input, tokenizer, model);
		const scored: Array<RerankerScore & { originalIndex: number }> = [];

		for (let offset = 0; offset < input.candidates.length; offset += this.batchSize) {
			const batch = input.candidates.slice(offset, offset + this.batchSize);
			const encoded = tokenizer(
				batch.map(() => input.query),
				{
					text_pair: batch.map((candidate) => candidate.content),
					padding: true,
					truncation: true,
					max_length: this.maxTokens,
				},
			);
			const output = await model(encoded);
			const scores = extractScores(output.logits, batch.length);
			for (let index = 0; index < batch.length; index += 1) {
				scored.push({
					id: batch[index].id,
					score: scores[index],
					originalIndex: offset + index,
				});
			}
		}

		scored.sort((left, right) => right.score - left.score || left.originalIndex - right.originalIndex);
		const limit =
			typeof input.topK === "number" && input.topK > 0
				? Math.min(Math.floor(input.topK), scored.length)
				: scored.length;
		return scored.slice(0, limit).map(({ id, score }) => ({ id, score }));
	}

	private async rerankMatchedChunks(
		input: RerankerInput,
		tokenizer: Tokenizer,
		model: SequenceClassificationModel,
	): Promise<RerankerScore[]> {
		const countTokens = (text: string) => tokenizer.encode(text, { add_special_tokens: false }).length;
		const pairOverhead = tokenizer.encode("", { text_pair: "", add_special_tokens: true }).length;
		const queryLimit = Math.min(128, Math.floor((this.maxTokens - pairOverhead) / 2));
		if (queryLimit < 1) throw new Error("Reranker input budget cannot fit a query/document pair");
		const queryTruncated = countTokens(input.query) > queryLimit;
		const query = queryTruncated
			? chunkTextByTokenBudget(input.query, { maxTokens: queryLimit, overlapTokens: 0, countTokens })[0]
					.content
			: input.query;
		const documentLimit = this.maxTokens - pairOverhead - countTokens(query);
		const work: Array<{
			parentIndex: number;
			content: string;
			sourceChunkId?: string;
			startPosition?: number;
			endPosition?: number;
			inputTokens: number;
		}> = [];
		for (const [parentIndex, candidate] of input.candidates.entries()) {
			const spans = candidate.metadata?.matchedSpans;
			const matched = Array.isArray(spans)
				? spans.filter(
						(
							span,
						): span is { matchedContent: string; sourceChunkId?: string; matchedStartPosition?: number } =>
							typeof span === "object" && span !== null && typeof span.matchedContent === "string",
					)
				: [];
			const sources = matched.length > 0 ? matched : [{ matchedContent: candidate.content }];
			const seen = new Set<string>();
			for (const source of sources) {
				const key = JSON.stringify([
					source.sourceChunkId,
					source.matchedStartPosition,
					source.matchedContent,
				]);
				if (seen.has(key)) continue;
				seen.add(key);
				const pieces = chunkTextByTokenBudget(source.matchedContent, {
					maxTokens: documentLimit,
					overlapTokens: Math.min(64, Math.floor(documentLimit / 6)),
					countTokens,
				});
				for (const piece of pieces.length ? pieces : [{ content: "", startPosition: 0, endPosition: 0 }]) {
					const inputTokens = tokenizer.encode(query, {
						text_pair: piece.content,
						add_special_tokens: true,
					}).length;
					if (inputTokens > this.maxTokens)
						throw new Error("Reranker pair exceeds its verified tokenizer budget");
					work.push({
						parentIndex,
						content: piece.content,
						inputTokens,
						sourceChunkId: source.sourceChunkId,
						...(typeof source.matchedStartPosition === "number"
							? {
									startPosition: source.matchedStartPosition + piece.startPosition,
									endPosition: source.matchedStartPosition + piece.endPosition,
								}
							: {}),
					});
				}
			}
		}
		const parents = input.candidates.map((candidate, index) => ({
			id: candidate.id,
			score: Number.NEGATIVE_INFINITY,
			index,
			evidenceScores: [] as NonNullable<RerankerScore["evidenceScores"]>,
		}));
		for (let offset = 0; offset < work.length; offset += this.batchSize) {
			const batch = work.slice(offset, offset + this.batchSize);
			const encoded = tokenizer(
				batch.map(() => query),
				{
					text_pair: batch.map((item) => item.content),
					padding: true,
					truncation: false,
					max_length: this.maxTokens,
				},
			);
			const scores = extractScores((await model(encoded)).logits, batch.length);
			for (const [index, item] of batch.entries()) {
				const parent = parents[item.parentIndex];
				parent.score = Math.max(parent.score, scores[index]);
				parent.evidenceScores.push({
					sourceChunkId: item.sourceChunkId,
					startPosition: item.startPosition,
					endPosition: item.endPosition,
					contentSha256: createHash("sha256").update(item.content).digest("hex"),
					score: scores[index],
					inputTokens: item.inputTokens,
					queryTruncated,
				});
			}
		}
		parents.sort((a, b) => b.score - a.score || a.index - b.index);
		const limit =
			input.topK && input.topK > 0 ? Math.min(Math.floor(input.topK), parents.length) : parents.length;
		return parents.slice(0, limit).map(({ id, score, evidenceScores }) => ({ id, score, evidenceScores }));
	}

	private async getComponents(): Promise<{
		tokenizer: Tokenizer;
		model: SequenceClassificationModel;
	}> {
		if (!this.componentsPromise) this.componentsPromise = this.loadComponents();
		return this.componentsPromise;
	}

	private async loadComponents(): Promise<{
		tokenizer: Tokenizer;
		model: SequenceClassificationModel;
	}> {
		const runtime = await this.runtimeLoader();
		runtime.env.cacheDir = this.cacheDir;
		if (this.remoteHost) runtime.env.remoteHost = this.remoteHost;
		const loadOptions: Record<string, unknown> = {
			cache_dir: this.cacheDir,
			local_files_only: this.localFilesOnly,
			...(this.device ? { device: this.device } : {}),
			...(this.dtype ? { dtype: this.dtype } : {}),
		};
		const [tokenizer, model] = await Promise.all([
			runtime.AutoTokenizer.from_pretrained(this.modelName, loadOptions),
			runtime.AutoModelForSequenceClassification.from_pretrained(this.modelName, loadOptions),
		]);
		return { tokenizer, model };
	}
}

function extractScores(logits: TensorLike, batchSize: number): number[] {
	const values = Array.from(logits.data, Number);
	if (values.length === 0 || values.length % batchSize !== 0) {
		throw new Error(`Local reranker returned ${values.length} logits for a batch of ${batchSize} candidates`);
	}
	const width = values.length / batchSize;
	return Array.from({ length: batchSize }, (_, index) => {
		// Cross-encoder rerankers normally emit one relevance logit. For a
		// two-label classifier, the last logit is the positive/relevant label.
		const score = values[index * width + (width - 1)];
		if (!Number.isFinite(score)) {
			throw new Error(`Local reranker returned a non-finite score for candidate ${index}`);
		}
		return score;
	});
}

function readPositiveInteger(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	return positiveInteger(Number.parseInt(raw, 10), name);
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isInteger(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive integer`);
	}
	return value;
}

export {
	DEFAULT_LOCAL_RERANKER_BATCH_SIZE,
	DEFAULT_LOCAL_RERANKER_CACHE_DIR,
	DEFAULT_LOCAL_RERANKER_MAX_TOKENS,
	DEFAULT_LOCAL_RERANKER_MODEL,
};
