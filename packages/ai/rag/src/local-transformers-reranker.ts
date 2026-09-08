import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_LOCAL_RERANKER_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";
const DEFAULT_LOCAL_RERANKER_CACHE_DIR = path.join(os.homedir(), ".cache", "opencontext", "local-reranker");
const DEFAULT_LOCAL_RERANKER_BATCH_SIZE = 8;
const DEFAULT_LOCAL_RERANKER_MAX_TOKENS = 512;

interface RerankerCandidate {
	id: string;
	content: string;
}

interface RerankerInput {
	query: string;
	candidates: RerankerCandidate[];
	topK?: number;
}

interface RerankerScore {
	id: string;
	score: number;
}

interface TensorLike {
	data: ArrayLike<number>;
	dims?: number[];
}

type Tokenizer = (
	texts: string[],
	options: {
		text_pair: string[];
		padding: boolean;
		truncation: boolean;
		max_length: number;
	},
) => Record<string, unknown>;

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
