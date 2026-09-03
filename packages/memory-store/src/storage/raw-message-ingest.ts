import type { RawMessage, RawMessageSearchChunk } from "@melandlabs/indexeddb";
import type { UnifiedSearchDeps } from "../config";
import { type EmbedOnInsertWarning, embedMissingMessages, prepareRawMessageIngest } from "../embed-on-insert";

export interface RawMessageIngestManager {
	storeMessages?(messages: RawMessage[]): Promise<number[]>;
	storeMessagesWithSearchChunks?(messages: RawMessage[], chunks: RawMessageSearchChunk[]): Promise<number[]>;
	upsertRawMessages?(input: { userId: string; messages: RawMessage[] }): Promise<unknown>;
}

export interface RawMessageChildVectorIndex {
	replaceMessages(messages: RawMessage[], chunks: RawMessageSearchChunk[]): Promise<void>;
}

export interface PersistRawMessagesInput {
	manager: RawMessageIngestManager;
	userId: string;
	messages: RawMessage[];
	embedOnInsert?: boolean;
	unified?: UnifiedSearchDeps;
	externalIndex?: RawMessageChildVectorIndex;
}

export interface PersistRawMessagesResult {
	count: number;
	ids?: number[];
	warnings: EmbedOnInsertWarning[];
}

/** Shared write path for HTTP, MCP and OKF. */
export async function persistRawMessages(input: PersistRawMessagesInput): Promise<PersistRawMessagesResult> {
	const prepared = await prepareRawMessageIngest(input.messages, input.embedOnInsert, input.unified);
	let ids: number[] | undefined;

	if (typeof input.manager.storeMessagesWithSearchChunks === "function") {
		ids = await input.manager.storeMessagesWithSearchChunks(prepared.messages, prepared.chunks);
	} else {
		const legacyMessages =
			(input.embedOnInsert === true || typeof input.unified?.embedQuery === "function") &&
			typeof input.unified?.embedQuery === "function"
				? await embedMissingMessages(prepared.messages, input.unified)
				: prepared.messages;
		if (typeof input.manager.upsertRawMessages === "function") {
			await input.manager.upsertRawMessages({ userId: input.userId, messages: legacyMessages });
		} else if (typeof input.manager.storeMessages === "function") {
			ids = await input.manager.storeMessages(legacyMessages);
		} else {
			throw new Error("active raw-message manager exposes no supported write method");
		}
	}

	if (input.externalIndex) {
		await input.externalIndex.replaceMessages(prepared.messages, prepared.chunks);
	}
	return { count: prepared.messages.length, ids, warnings: prepared.warnings };
}
