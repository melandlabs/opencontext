import type {
	ClientConfig,
	ConsistencyLevelEnum,
	DescribeCollectionResponse,
	HybridSearchReq,
	MilvusClient,
	SearchResultData,
	SearchSimpleReq,
} from "@zilliz/milvus2-sdk-node";

import type {
	DocumentChunk,
	HybridSearchFilter,
	HybridSearchQuery,
	IHybridVectorStore,
	VectorSearchResult,
} from "./vector-service";

type MilvusModule = typeof import("@zilliz/milvus2-sdk-node");

export interface MilvusStoreOptions {
	address?: string;
	/** An existing MilvusClient. The adapter does not close injected clients. */
	client?: object;
	token?: string;
	username?: string;
	password?: string;
	ssl?: boolean;
	database?: string;
	collectionName?: string;
	dimension?: number;
	consistencyLevel?: "Strong" | "Session" | "Bounded" | "Eventually" | "Customized";
	denseMetric?: "COSINE" | "IP" | "L2";
	denseIndexType?: "HNSW" | "IVF_FLAT" | "AUTOINDEX";
	defaultFusion?: "rrf" | "weighted";
	defaultAlpha?: number;
	defaultRrfK?: number;
	candidateMultiplier?: number;
	maxIdLength?: number;
	maxDocumentIdLength?: number;
	maxUserIdLength?: number;
	maxContentLength?: number;
}

type MilvusConsistencyLevel = "Strong" | "Session" | "Bounded" | "Eventually" | "Customized";

const CONSISTENCY_LEVEL_VALUES: Record<MilvusConsistencyLevel, ConsistencyLevelEnum> = {
	Strong: 0 as ConsistencyLevelEnum,
	Session: 1 as ConsistencyLevelEnum,
	Bounded: 2 as ConsistencyLevelEnum,
	Eventually: 3 as ConsistencyLevelEnum,
	Customized: 4 as ConsistencyLevelEnum,
};

const DEFAULT_COLLECTION_NAME = "opencontext_chunks";
const DEFAULT_LIMIT = 10;
const DEFAULT_CANDIDATE_MULTIPLIER = 4;
const DEFAULT_MAX_ID_LENGTH = 512;
const DEFAULT_MAX_CONTENT_LENGTH = 65_535;

const FIELDS = {
	id: "id",
	documentId: "document_id",
	userId: "user_id",
	content: "content",
	metadata: "metadata",
	dense: "dense_vector",
	sparse: "sparse_vector",
} as const;

function assertPositiveInteger(value: number, name: string): void {
	if (!Number.isInteger(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive integer`);
	}
}

function assertAlpha(alpha: number): void {
	if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
		throw new RangeError("alpha must be between 0 and 1");
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

function assertMaxLength(value: string, maxLength: number, field: string): void {
	if (new TextEncoder().encode(value).length > maxLength) {
		throw new RangeError(`${field} exceeds its configured UTF-8 byte limit of ${maxLength}`);
	}
}

function quoteMilvus(value: string): string {
	return JSON.stringify(value);
}

function buildFilter(filter?: HybridSearchFilter): string | undefined {
	const predicates: string[] = [];
	if (filter?.userId) predicates.push(`${FIELDS.userId} == ${quoteMilvus(filter.userId)}`);
	if (filter?.documentIds?.length) {
		predicates.push(`${FIELDS.documentId} in [${filter.documentIds.map(quoteMilvus).join(", ")}]`);
	}
	return predicates.length ? predicates.join(" and ") : undefined;
}

function metadataUserId(metadata: Record<string, unknown> | undefined): string {
	return typeof metadata?.userId === "string" ? metadata.userId : "";
}

function fieldDimension(description: DescribeCollectionResponse): number | undefined {
	const field = description.schema.fields.find((candidate) => candidate.name === FIELDS.dense);
	const dimension = field?.dim ?? field?.type_params.find((param) => param.key === "dim")?.value;
	const parsed = typeof dimension === "number" ? dimension : Number(dimension);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Milvus 2.5+ store using one collection with dense and BM25-generated sparse vectors. */
export class MilvusStore implements IHybridVectorStore {
	private readonly address?: string;
	private readonly clientOptions: Omit<ClientConfig, "address">;
	private readonly collectionName: string;
	private readonly consistencyLevelName: MilvusConsistencyLevel;
	private readonly consistencyLevel: ConsistencyLevelEnum;
	private readonly denseMetric: "COSINE" | "IP" | "L2";
	private readonly denseIndexType: "HNSW" | "IVF_FLAT" | "AUTOINDEX";
	private readonly defaultFusion: "rrf" | "weighted";
	private readonly defaultAlpha: number;
	private readonly defaultRrfK: number;
	private readonly candidateMultiplier: number;
	private readonly maxIdLength: number;
	private readonly maxDocumentIdLength: number;
	private readonly maxUserIdLength: number;
	private readonly maxContentLength: number;
	private readonly ownsClient: boolean;
	private readonly configuredDimension?: number;

	private client?: MilvusClient;
	private dimension?: number;
	private collectionReady = false;
	private initialization?: Promise<boolean>;
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(options: MilvusStoreOptions) {
		if (!options.client && !options.address) {
			throw new TypeError("MilvusStore requires either address or client");
		}
		this.address = options.address;
		this.client = options.client as MilvusClient | undefined;
		this.ownsClient = !options.client;
		this.clientOptions = {
			token: options.token,
			username: options.username,
			password: options.password,
			ssl: options.ssl,
			database: options.database,
		};
		this.collectionName = options.collectionName ?? DEFAULT_COLLECTION_NAME;
		this.configuredDimension = options.dimension;
		this.dimension = this.configuredDimension;
		this.consistencyLevelName = options.consistencyLevel ?? "Bounded";
		this.consistencyLevel = CONSISTENCY_LEVEL_VALUES[this.consistencyLevelName];
		this.denseMetric = options.denseMetric ?? "COSINE";
		this.denseIndexType = options.denseIndexType ?? "HNSW";
		this.defaultFusion = options.defaultFusion ?? "rrf";
		this.defaultAlpha = options.defaultAlpha ?? 0.5;
		this.defaultRrfK = options.defaultRrfK ?? 60;
		this.candidateMultiplier = options.candidateMultiplier ?? DEFAULT_CANDIDATE_MULTIPLIER;
		this.maxIdLength = options.maxIdLength ?? DEFAULT_MAX_ID_LENGTH;
		this.maxDocumentIdLength = options.maxDocumentIdLength ?? DEFAULT_MAX_ID_LENGTH;
		this.maxUserIdLength = options.maxUserIdLength ?? DEFAULT_MAX_ID_LENGTH;
		this.maxContentLength = options.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH;

		if (this.dimension !== undefined) assertPositiveInteger(this.dimension, "dimension");
		assertAlpha(this.defaultAlpha);
		assertPositiveInteger(this.defaultRrfK, "defaultRrfK");
		assertPositiveInteger(this.candidateMultiplier, "candidateMultiplier");
		assertPositiveInteger(this.maxIdLength, "maxIdLength");
		assertPositiveInteger(this.maxDocumentIdLength, "maxDocumentIdLength");
		assertPositiveInteger(this.maxUserIdLength, "maxUserIdLength");
		assertPositiveInteger(this.maxContentLength, "maxContentLength");
	}

	private async module(): Promise<MilvusModule> {
		try {
			return await import("@zilliz/milvus2-sdk-node");
		} catch (error) {
			throw new Error("MilvusStore requires the optional peer dependency @zilliz/milvus2-sdk-node", {
				cause: error,
			});
		}
	}

	private async getClient(): Promise<MilvusClient> {
		if (this.client) return this.client;
		const milvus = await this.module();
		this.client = new milvus.MilvusClient({
			address: this.address as string,
			...this.clientOptions,
		});
		return this.client;
	}

	private validateExistingCollection(
		description: DescribeCollectionResponse,
		requestedDimension?: number,
	): void {
		const vectorFields = new Set(description.schema.fields.map((field) => field.name));
		if (!vectorFields.has(FIELDS.dense) || !vectorFields.has(FIELDS.sparse)) {
			throw new Error(
				`Milvus collection ${this.collectionName} must contain ${FIELDS.dense} and ${FIELDS.sparse}`,
			);
		}
		const hasBm25Function = description.schema.functions.some(
			(candidate) =>
				candidate.input_field_names.includes(FIELDS.content) &&
				candidate.output_field_names?.includes(FIELDS.sparse),
		);
		if (!hasBm25Function) {
			throw new Error(
				`Milvus collection ${this.collectionName} must define a BM25 function from ${FIELDS.content} to ${FIELDS.sparse}`,
			);
		}
		const existingDimension = fieldDimension(description);
		if (existingDimension !== undefined) this.dimension = existingDimension;
		if (
			requestedDimension !== undefined &&
			existingDimension !== undefined &&
			requestedDimension !== existingDimension
		) {
			throw new RangeError(
				`Embedding dimension ${requestedDimension} does not match Milvus collection dimension ${existingDimension}`,
			);
		}
	}

	private async ensureIndexes(client: MilvusClient): Promise<void> {
		const existing = await client.listIndexes({ collection_name: this.collectionName });
		const indexNames = new Set(existing.indexes);
		const missing = [];
		if (!indexNames.has("dense_idx")) {
			missing.push({
				collection_name: this.collectionName,
				field_name: FIELDS.dense,
				index_name: "dense_idx",
				index_type: this.denseIndexType,
				metric_type: this.denseMetric,
				params: this.denseIndexType === "HNSW" ? { M: 16, efConstruction: 200 } : {},
			});
		}
		if (!indexNames.has("sparse_bm25_idx")) {
			missing.push({
				collection_name: this.collectionName,
				field_name: FIELDS.sparse,
				index_name: "sparse_bm25_idx",
				index_type: "SPARSE_INVERTED_INDEX",
				metric_type: "BM25",
				params: { drop_ratio_build: 0.2 },
			});
		}
		if (missing.length) await client.createIndex(missing);
	}

	private async initializeCollection(requestedDimension?: number): Promise<boolean> {
		const client = await this.getClient();
		const exists = await client.hasCollection({ collection_name: this.collectionName });
		if (exists.value) {
			const description = await client.describeCollection({ collection_name: this.collectionName });
			this.validateExistingCollection(description, requestedDimension);
			await this.ensureIndexes(client);
			await client.loadCollection({ collection_name: this.collectionName });
			this.collectionReady = true;
			return true;
		}

		const dimension = requestedDimension ?? this.dimension;
		if (dimension === undefined) return false;
		assertPositiveInteger(dimension, "dimension");
		const milvus = await this.module();
		await client.createCollection({
			collection_name: this.collectionName,
			consistency_level: this.consistencyLevelName,
			fields: [
				{
					name: FIELDS.id,
					data_type: milvus.DataType.VarChar,
					is_primary_key: true,
					autoID: false,
					max_length: this.maxIdLength,
				},
				{
					name: FIELDS.documentId,
					data_type: milvus.DataType.VarChar,
					max_length: this.maxDocumentIdLength,
				},
				{
					name: FIELDS.userId,
					data_type: milvus.DataType.VarChar,
					max_length: this.maxUserIdLength,
				},
				{
					name: FIELDS.content,
					data_type: milvus.DataType.VarChar,
					max_length: this.maxContentLength,
					enable_analyzer: true,
					enable_match: true,
				},
				{ name: FIELDS.metadata, data_type: milvus.DataType.JSON },
				{ name: FIELDS.dense, data_type: milvus.DataType.FloatVector, dim: dimension },
				{
					name: FIELDS.sparse,
					data_type: milvus.DataType.SparseFloatVector,
					is_function_output: true,
				},
			],
			functions: [
				{
					name: "content_bm25",
					type: milvus.FunctionType.BM25,
					input_field_names: [FIELDS.content],
					output_field_names: [FIELDS.sparse],
					params: {},
				},
			],
		});
		await this.ensureIndexes(client);
		await client.loadCollection({ collection_name: this.collectionName });
		this.dimension = dimension;
		this.collectionReady = true;
		return true;
	}

	private async ensureCollection(requestedDimension?: number): Promise<boolean> {
		if (this.collectionReady) {
			if (
				requestedDimension !== undefined &&
				this.dimension !== undefined &&
				requestedDimension !== this.dimension
			) {
				throw new RangeError(
					`Embedding dimension ${requestedDimension} does not match store dimension ${this.dimension}`,
				);
			}
			return true;
		}
		if (this.initialization) {
			const initialized = await this.initialization;
			if (initialized || requestedDimension === undefined) return initialized;
		}
		this.initialization = this.initializeCollection(requestedDimension);
		try {
			return await this.initialization;
		} finally {
			this.initialization = undefined;
		}
	}

	private enqueueWrite(operation: () => Promise<void>): Promise<void> {
		const result = this.writeQueue.then(operation, operation);
		this.writeQueue = result.catch(() => undefined);
		return result;
	}

	private validateChunk(chunk: DocumentChunk, dimension: number): void {
		assertEmbedding(chunk.embedding, dimension);
		const userId = metadataUserId(chunk.metadata);
		assertMaxLength(chunk.id, this.maxIdLength, "chunk id");
		assertMaxLength(chunk.documentId, this.maxDocumentIdLength, "document id");
		assertMaxLength(userId, this.maxUserIdLength, "user id");
		assertMaxLength(chunk.content, this.maxContentLength, "content");
	}

	async addChunk(chunk: DocumentChunk): Promise<void> {
		await this.addChunks([chunk]);
	}

	async addChunks(chunks: DocumentChunk[]): Promise<void> {
		if (chunks.length === 0) return;
		const inputDimension = chunks[0].embedding.length;
		for (const chunk of chunks) this.validateChunk(chunk, inputDimension);

		await this.enqueueWrite(async () => {
			await this.ensureCollection(inputDimension);
			for (const chunk of chunks) this.validateChunk(chunk, this.dimension as number);
			const client = await this.getClient();
			await client.upsert({
				collection_name: this.collectionName,
				data: chunks.map((chunk) => ({
					[FIELDS.id]: chunk.id,
					[FIELDS.documentId]: chunk.documentId,
					[FIELDS.userId]: metadataUserId(chunk.metadata),
					[FIELDS.content]: chunk.content,
					[FIELDS.metadata]: chunk.metadata ?? {},
					[FIELDS.dense]: chunk.embedding,
				})),
			});
		});
	}

	private rowToResult(row: SearchResultData): VectorSearchResult {
		const metadata = row[FIELDS.metadata];
		return {
			id: String(row.id),
			documentId: String(row[FIELDS.documentId]),
			content: String(row[FIELDS.content]),
			score: Number(row.score),
			metadata:
				metadata && typeof metadata === "object" && !Array.isArray(metadata)
					? (metadata as Record<string, unknown>)
					: undefined,
		};
	}

	private outputFields(): string[] {
		return [FIELDS.id, FIELDS.documentId, FIELDS.content, FIELDS.metadata];
	}

	async similaritySearch(
		queryEmbedding: number[],
		limit = DEFAULT_LIMIT,
		userId?: string,
	): Promise<VectorSearchResult[]> {
		assertEmbedding(queryEmbedding, this.dimension);
		assertPositiveInteger(limit, "limit");
		await this.writeQueue;
		if (!(await this.ensureCollection(queryEmbedding.length))) return [];
		assertEmbedding(queryEmbedding, this.dimension);
		const client = await this.getClient();
		const request: SearchSimpleReq = {
			collection_name: this.collectionName,
			data: queryEmbedding,
			anns_field: FIELDS.dense,
			limit,
			filter: buildFilter(userId ? { userId } : undefined),
			output_fields: this.outputFields(),
			metric_type: this.denseMetric,
			params: this.denseIndexType === "HNSW" ? { ef: Math.max(64, limit) } : {},
			consistency_level: this.consistencyLevel,
		};
		const response = await client.search(request);
		return response.results.map((row) => this.rowToResult(row));
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
		if (!(await this.ensureCollection(query.vector?.length))) return [];
		if (query.vector) assertEmbedding(query.vector, this.dimension);
		const client = await this.getClient();
		const filter = buildFilter(query.filter);

		if (!query.vector?.length || !text) {
			const isDense = Boolean(query.vector?.length);
			const request: SearchSimpleReq = {
				collection_name: this.collectionName,
				data: isDense ? (query.vector as number[]) : text,
				anns_field: isDense ? FIELDS.dense : FIELDS.sparse,
				limit,
				filter,
				output_fields: this.outputFields(),
				metric_type: isDense ? this.denseMetric : "BM25",
				params: isDense && this.denseIndexType === "HNSW" ? { ef: Math.max(64, limit) } : {},
				consistency_level: this.consistencyLevel,
			};
			const response = await client.search(request);
			return response.results.map((row) => this.rowToResult(row));
		}

		const milvus = await this.module();
		const strategy = query.fusion ?? this.defaultFusion;
		const rerank =
			strategy === "rrf"
				? milvus.RRFRanker(query.rrfK ?? this.defaultRrfK)
				: milvus.WeightedRanker([query.alpha ?? this.defaultAlpha, 1 - (query.alpha ?? this.defaultAlpha)]);
		if (strategy === "rrf") assertPositiveInteger(query.rrfK ?? this.defaultRrfK, "rrfK");
		else assertAlpha(query.alpha ?? this.defaultAlpha);

		const request: HybridSearchReq = {
			collection_name: this.collectionName,
			data: [
				{
					data: query.vector,
					anns_field: FIELDS.dense,
					expr: filter,
					params: {
						metric_type: this.denseMetric,
						...(this.denseIndexType === "HNSW" ? { ef: Math.max(64, candidateLimit) } : {}),
					},
				},
				{
					data: text,
					anns_field: FIELDS.sparse,
					expr: filter,
					params: { metric_type: "BM25" },
				},
			],
			limit: candidateLimit,
			output_fields: this.outputFields(),
			rerank,
			consistency_level: this.consistencyLevel,
		};
		const response = await client.search(request);
		return response.results.slice(0, limit).map((row) => this.rowToResult(row));
	}

	async deleteDocument(documentId: string): Promise<void> {
		await this.enqueueWrite(async () => {
			if (!(await this.ensureCollection())) return;
			const client = await this.getClient();
			await client.delete({
				collection_name: this.collectionName,
				filter: `${FIELDS.documentId} == ${quoteMilvus(documentId)}`,
			});
		});
	}

	async getDocumentCount(): Promise<number> {
		await this.writeQueue;
		if (!(await this.ensureCollection())) return 0;
		const client = await this.getClient();
		const iterator = await client.queryIterator({
			collection_name: this.collectionName,
			output_fields: [FIELDS.documentId],
			batchSize: 1_000,
		});
		const documentIds = new Set<string>();
		for await (const rows of iterator as AsyncIterable<Array<Record<string, unknown>>>) {
			for (const row of rows) documentIds.add(String(row[FIELDS.documentId]));
		}
		return documentIds.size;
	}

	async getChunkCount(): Promise<number> {
		await this.writeQueue;
		if (!(await this.ensureCollection())) return 0;
		const client = await this.getClient();
		const response = await client.count({ collection_name: this.collectionName });
		return response.data;
	}

	async clear(): Promise<void> {
		await this.enqueueWrite(async () => {
			const client = await this.getClient();
			const exists = await client.hasCollection({ collection_name: this.collectionName });
			if (exists.value) await client.dropCollection({ collection_name: this.collectionName });
			this.collectionReady = false;
			this.dimension = this.configuredDimension;
			this.initialization = undefined;
		});
	}

	async close(): Promise<void> {
		await this.writeQueue;
		if (this.ownsClient && this.client) await this.client.closeConnection();
		this.client = undefined;
		this.collectionReady = false;
	}
}
