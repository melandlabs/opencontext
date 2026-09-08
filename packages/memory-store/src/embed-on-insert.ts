import { createHash } from "node:crypto";
import type { RawMessage, RawMessageSearchChunk } from "@melandlabs/indexeddb";
import { chunkTextByEstimatedTokens } from "../../shared/src/text-chunking";
import type { UnifiedSearchDeps } from "./config";

export interface EmbedOnInsertWarning {
	code: string;
	message: string;
}

export interface EmbedOnInsertResult {
	messages: RawMessage[];
	warnings: EmbedOnInsertWarning[];
}

export interface PreparedRawMessageIngest extends EmbedOnInsertResult {
	chunks: RawMessageSearchChunk[];
}

const AUTO_APPLIED_WARNING: EmbedOnInsertWarning = {
	code: "embed_on_insert_auto_applied",
	message:
		"Caller did not explicitly enable embedOnInsert, but an embedding provider is configured. " +
		"OpenContext generated the missing search embeddings.",
};

const SEMANTIC_UNAVAILABLE_WARNING: EmbedOnInsertWarning = {
	code: "semantic_index_unavailable",
	message:
		"No embedding provider is configured. RawMessage children were indexed for lexical search only; " +
		"semantic search is unavailable until they are explicitly reindexed.",
};

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function isUsableEmbedding(embedding: number[] | undefined): embedding is number[] {
	return Boolean(
		embedding?.length && embedding.every(Number.isFinite) && embedding.some((value) => value !== 0),
	);
}

async function embedText(
	text: string,
	userId: string,
	deps: UnifiedSearchDeps,
): Promise<number[] | undefined> {
	if (typeof deps.embedQuery !== "function" || text.length === 0) return undefined;
	const embedding = await deps.embedQuery({ userId, query: text });
	return isUsableEmbedding(embedding) ? embedding : undefined;
}

/** Fill only missing parent embeddings for legacy parent-level stores. */
export async function embedMissingMessages(
	messages: RawMessage[],
	deps: UnifiedSearchDeps,
): Promise<RawMessage[]> {
	if (typeof deps.embedQuery !== "function") return messages;
	const out: RawMessage[] = [];
	for (const message of messages) {
		if (isUsableEmbedding(message.embedding) || !message.content) {
			out.push(message);
			continue;
		}
		const embedding = await embedText(message.content, message.userId, deps);
		out.push(
			embedding
				? {
						...message,
						embedding,
						embeddingModel: message.embeddingModel ?? deps.embeddingInfo?.model ?? "server",
						embeddingContentHash: sha256(message.content),
						embeddingDimensions: embedding.length,
						embeddingUpdatedAt: Date.now(),
					}
				: message,
		);
	}
	return out;
}

/**
 * Prepare complete RawMessage parents and search-only children. Long parents
 * never reuse or average a parent vector; every child is embedded independently.
 */
export async function prepareRawMessageIngest(
	incoming: RawMessage[],
	embedOnInsert: boolean | undefined,
	unified: UnifiedSearchDeps | undefined,
): Promise<PreparedRawMessageIngest> {
	const deps = unified ?? {};
	const embedderAvailable =
		typeof deps.embedQuery === "function" || typeof deps.embedDocuments === "function";
	const shouldEmbed = embedOnInsert === true || embedderAvailable;
	const messages: RawMessage[] = [];
	const chunks: RawMessageSearchChunk[] = [];
	let missingSemanticEmbedding = false;
	let generatedEmbedding = false;
	const plans = incoming.map((message) => ({
		message,
		pieces: chunkTextByEstimatedTokens(message.content),
	}));
	const generatedEmbeddings = new Map<string, number[]>();
	const pendingByUser = new Map<string, Array<{ key: string; text: string }>>();

	for (const [messageIndex, plan] of plans.entries()) {
		for (const piece of plan.pieces) {
			const canReuseParentEmbedding = plan.pieces.length === 1 && isUsableEmbedding(plan.message.embedding);
			if (canReuseParentEmbedding || !shouldEmbed || piece.content.length === 0) continue;
			const pending = pendingByUser.get(plan.message.userId) ?? [];
			pending.push({ key: `${messageIndex}:${piece.chunkIndex}`, text: piece.content });
			pendingByUser.set(plan.message.userId, pending);
		}
	}

	for (const [userId, pending] of pendingByUser) {
		let embeddings: Array<number[] | undefined>;
		if (typeof deps.embedDocuments === "function") {
			const batch = await deps.embedDocuments({
				userId,
				texts: pending.map((item) => item.text),
			});
			if (batch.length !== pending.length) {
				throw new Error(
					`Document embedding count mismatch: expected ${pending.length}, received ${batch.length}`,
				);
			}
			embeddings = batch.map((embedding) => (isUsableEmbedding(embedding) ? embedding : undefined));
		} else {
			embeddings = [];
			for (const item of pending) {
				embeddings.push(await embedText(item.text, userId, deps));
			}
		}
		for (const [index, item] of pending.entries()) {
			const embedding = embeddings[index];
			if (embedding) generatedEmbeddings.set(item.key, embedding);
		}
	}

	for (const [messageIndex, plan] of plans.entries()) {
		const incomingMessage = plan.message;
		const pieces = plan.pieces;
		let message = incomingMessage;
		for (const piece of pieces) {
			const contentHash = sha256(piece.content);
			const canReuseParentEmbedding = pieces.length === 1 && isUsableEmbedding(incomingMessage.embedding);
			const embedding = canReuseParentEmbedding
				? incomingMessage.embedding
				: generatedEmbeddings.get(`${messageIndex}:${piece.chunkIndex}`);
			generatedEmbedding = generatedEmbedding || Boolean(embedding && !canReuseParentEmbedding);
			if (!embedding) missingSemanticEmbedding = true;
			const embeddingModel = embedding
				? canReuseParentEmbedding
					? incomingMessage.embeddingModel
					: (deps.embeddingInfo?.model ?? incomingMessage.embeddingModel ?? "server")
				: undefined;
			chunks.push({
				chunkId: `${incomingMessage.messageId}:chunk:${piece.chunkIndex}:${contentHash.slice(0, 16)}`,
				messageId: incomingMessage.messageId,
				userId: incomingMessage.userId,
				chunkIndex: piece.chunkIndex,
				chunkCount: pieces.length,
				startPosition: piece.startPosition,
				endPosition: piece.endPosition,
				content: piece.content,
				contentHash,
				embedding,
				embeddingModel,
				embeddingDimensions: embedding?.length,
				embeddingUpdatedAt: embedding ? Date.now() : undefined,
			});

			if (pieces.length === 1 && embedding && !incomingMessage.embedding?.length) {
				message = {
					...incomingMessage,
					embedding,
					embeddingModel,
					embeddingContentHash: contentHash,
					embeddingDimensions: embedding.length,
					embeddingUpdatedAt: Date.now(),
				};
			}
		}
		messages.push(message);
	}

	const warnings: EmbedOnInsertWarning[] = [];
	if (generatedEmbedding && embedOnInsert !== true) warnings.push(AUTO_APPLIED_WARNING);
	if (missingSemanticEmbedding) warnings.push(SEMANTIC_UNAVAILABLE_WARNING);
	return { messages, chunks, warnings };
}

export async function applyEmbedOnInsertPolicy(
	incoming: RawMessage[],
	embedOnInsert: boolean | undefined,
	unified: UnifiedSearchDeps | undefined,
): Promise<EmbedOnInsertResult> {
	const prepared = await prepareRawMessageIngest(incoming, embedOnInsert, unified);
	return { messages: prepared.messages, warnings: prepared.warnings };
}
