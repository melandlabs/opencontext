import * as os from "node:os";
import * as path from "node:path";

import type { EmbeddingProvider } from "./embedding-provider";

const DEFAULT_LOCAL_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_LOCAL_EMBEDDING_CACHE_DIR = path.join(
	os.homedir(),
	".cache",
	"opencontext",
	"local-embeddings",
);
const DEFAULT_LOCAL_EMBEDDING_BATCH_SIZE = 8;
const DEFAULT_LOCAL_EMBEDDING_MAX_TOKENS = 512;
const DEFAULT_LOCAL_EMBEDDING_POOLING = "mean";
const DEFAULT_LOCAL_EMBEDDING_NORMALIZE = true;

type FeatureExtractionPipeline = (
	texts: string | string[],
	options?: {
		pooling?: LocalTransformersEmbeddingProviderOptions["pooling"];
		normalize?: boolean;
	},
) => Promise<unknown>;

// Transformers.js' public types don't cover tokenizer config mutation or
// every device/dtype union member, so we model the pieces we touch as an
// explicit `unknown`-friendly shape and avoid `any` casts downstream.
type ExtractorWithTokenizer = {
	tokenizer?: { model_max_length?: number };
};

type TransformersModule = {
	env: { cacheDir: string; remoteHost: string };
	pipeline: (
		task: "feature-extraction",
		model: string,
		options: Record<string, unknown>,
	) => Promise<FeatureExtractionPipeline>;
};

export interface LocalTransformersEmbeddingProviderOptions {
	modelName?: string;
	batchSize?: number;
	cacheDir?: string;
	remoteHost?: string;
	device?: string;
	dtype?: string;
	localFilesOnly?: boolean;
	maxTokens?: number;
	pooling?: "none" | "mean" | "cls" | "first_token" | "eos" | "last_token";
	normalize?: boolean;
}

export class LocalTransformersEmbeddingProvider implements EmbeddingProvider {
	private modelName: string;
	private batchSize: number;
	private cacheDir?: string;
	private remoteHost?: string;
	private device?: string;
	private dtype?: string;
	private localFilesOnly: boolean;
	private maxTokens: number;
	private pooling: NonNullable<LocalTransformersEmbeddingProviderOptions["pooling"]>;
	private normalize: boolean;
	private dimensions?: number;
	private extractorPromise?: Promise<FeatureExtractionPipeline>;

	constructor(options: LocalTransformersEmbeddingProviderOptions = {}) {
		this.modelName = options.modelName || process.env.LOCAL_EMBEDDING_MODEL || DEFAULT_LOCAL_EMBEDDING_MODEL;
		this.batchSize = options.batchSize ?? getLocalEmbeddingBatchSize();
		// Use a stable, user-level cache directory by default so the model weights
		// survive `npx` installs (which use a fresh, throw-away node_modules tree).
		// Without this, Transformers.js falls back to `<transformers-pkg>/.cache`,
		// which is empty for every new npx temp directory.
		this.cacheDir =
			options.cacheDir || process.env.LOCAL_EMBEDDING_CACHE_DIR || DEFAULT_LOCAL_EMBEDDING_CACHE_DIR;
		this.remoteHost = options.remoteHost || process.env.LOCAL_EMBEDDING_REMOTE_HOST || undefined;
		this.device = options.device || process.env.LOCAL_EMBEDDING_DEVICE || undefined;
		this.dtype = options.dtype || process.env.LOCAL_EMBEDDING_DTYPE || undefined;
		this.localFilesOnly = options.localFilesOnly ?? process.env.LOCAL_EMBEDDING_LOCAL_ONLY === "true";
		this.maxTokens = options.maxTokens ?? getLocalEmbeddingMaxTokens();
		this.pooling = options.pooling || DEFAULT_LOCAL_EMBEDDING_POOLING;
		this.normalize = options.normalize ?? DEFAULT_LOCAL_EMBEDDING_NORMALIZE;
	}

	getModelName(): string {
		return this.modelName;
	}

	getDimensions(): number | undefined {
		return this.dimensions;
	}

	getCacheDir(): string | undefined {
		return this.cacheDir;
	}

	async embedDocuments(texts: string[]): Promise<number[][]> {
		if (texts.length === 0) {
			throw new Error("No texts provided for embedding");
		}

		const results: number[][] = [];

		for (let i = 0; i < texts.length; i += this.batchSize) {
			const batch = texts.slice(i, i + this.batchSize);
			const batchEmbeddings = await this.embedBatch(batch);
			results.push(...batchEmbeddings);
		}

		return results;
	}

	async embedQuery(text: string): Promise<number[]> {
		const embeddings = await this.embedBatch([text]);
		return embeddings[0];
	}

	private async embedBatch(texts: string[]): Promise<number[][]> {
		const extractor = await this.getExtractor();

		const output = await extractor(texts, {
			pooling: this.pooling,
			normalize: this.normalize,
		});
		const embeddings = tensorToEmbeddings(output, texts.length);

		this.dimensions = embeddings[0]?.length ?? this.dimensions;
		return embeddings;
	}

	private async getExtractor(): Promise<FeatureExtractionPipeline> {
		this.extractorPromise ??= this.createExtractor();
		return this.extractorPromise;
	}

	private async createExtractor(): Promise<FeatureExtractionPipeline> {
		const transformers = (await import("@huggingface/transformers")) as TransformersModule;

		if (this.cacheDir) {
			transformers.env.cacheDir = this.cacheDir;
		}
		if (this.remoteHost) {
			transformers.env.remoteHost = this.remoteHost;
		}

		const extractor = await transformers.pipeline("feature-extraction", this.modelName, {
			cache_dir: this.cacheDir,
			device: this.device,
			dtype: this.dtype,
			local_files_only: this.localFilesOnly,
		});

		// Transformers.js feature-extraction always enables truncation, but relies
		// on tokenizer.model_max_length. Some ONNX exports advertise a tokenizer
		// limit larger than the model position embeddings, so clamp it explicitly.
		const extractorWithTokenizer = extractor as unknown as ExtractorWithTokenizer;
		if (extractorWithTokenizer.tokenizer && this.maxTokens > 0) {
			extractorWithTokenizer.tokenizer.model_max_length = this.maxTokens;
		}

		return extractor;
	}
}

function tensorToEmbeddings(output: unknown, expectedCount: number): number[][] {
	const tensorLike = output as
		| {
				tolist?: () => unknown;
				data?: ArrayLike<number>;
				dims?: number[];
		  }
		| null
		| undefined;
	const nested = typeof tensorLike?.tolist === "function" ? tensorLike.tolist() : null;

	if (Array.isArray(nested)) {
		return normalizeEmbeddingShape(nested, expectedCount);
	}

	if (tensorLike?.data && Array.isArray(tensorLike?.dims)) {
		const data = Array.from(tensorLike.data);
		const dims = tensorLike.dims;

		if (dims.length === 2) {
			const [rows, columns] = dims;
			if (rows !== expectedCount) {
				throw new Error(`Local embedding output count mismatch. Expected ${expectedCount}, got ${rows}.`);
			}
			return chunkFlatEmbeddingData(data, rows, columns);
		}
	}

	throw new Error("Unsupported local embedding output format from Transformers.js.");
}

function normalizeEmbeddingShape(value: unknown, expectedCount: number): number[][] {
	if (!Array.isArray(value)) {
		throw new Error("Invalid local embedding output: expected an array.");
	}

	if (expectedCount === 1 && value.every((item) => typeof item === "number")) {
		return [value as number[]];
	}

	if (value.length !== expectedCount) {
		throw new Error(`Local embedding output count mismatch. Expected ${expectedCount}, got ${value.length}.`);
	}

	return value.map((item) => {
		if (!Array.isArray(item) || !item.every((entry) => typeof entry === "number")) {
			throw new Error("Invalid local embedding vector shape.");
		}
		return item as number[];
	});
}

function chunkFlatEmbeddingData(data: number[], rows: number, columns: number): number[][] {
	const results: number[][] = [];

	for (let row = 0; row < rows; row += 1) {
		results.push(data.slice(row * columns, (row + 1) * columns));
	}

	return results;
}

function getLocalEmbeddingBatchSize(): number {
	const rawBatchSize = process.env.LOCAL_EMBEDDING_BATCH_SIZE;
	if (!rawBatchSize) return DEFAULT_LOCAL_EMBEDDING_BATCH_SIZE;

	const parsedBatchSize = Number(rawBatchSize);
	if (!Number.isFinite(parsedBatchSize) || parsedBatchSize < 1) {
		return DEFAULT_LOCAL_EMBEDDING_BATCH_SIZE;
	}

	return Math.floor(parsedBatchSize);
}

function getLocalEmbeddingMaxTokens(): number {
	const rawMaxTokens = process.env.LOCAL_EMBEDDING_MAX_TOKENS;
	if (!rawMaxTokens) return DEFAULT_LOCAL_EMBEDDING_MAX_TOKENS;

	const parsedMaxTokens = Number(rawMaxTokens);
	if (!Number.isFinite(parsedMaxTokens) || parsedMaxTokens < 1) {
		return DEFAULT_LOCAL_EMBEDDING_MAX_TOKENS;
	}

	return Math.floor(parsedMaxTokens);
}
