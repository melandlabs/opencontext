/**
 * MemoryStore-derived peer helpers.
 *
 * Convenience adapters that turn a `MemoryStore` into the two callback
 * inputs `createPeerProfile` expects (`listKnownPeers` and
 * `listPeerMentions`). Pure derivation — no new storage, no new
 * indexing — so they ride on the existing `RawMessage.peer` /
 * `metadata.mentions` plumbing.
 *
 * Author identity is resolved with this priority:
 *
 *   1. `RawMessage.peer?.id`   — the structured Peer abstraction
 *                                (server-side ingest path).
 *   2. `RawMessage.person`     — the legacy author label.
 *   3. `RawMessage.userId`     — fallback to the workspace key.
 *
 * Mentions are read from `metadata.mentions` (an array of peer IDs).
 * Hosts that store mentions elsewhere should keep using their own
 * `listPeerMentions()` callback rather than relying on this helper.
 *
 * These helpers are additive — `MemoryStore` itself is unchanged.
 */

import { type Peer, peerKey } from "@melandlabs/contracts/peer";
import type { RawMessageStorageManager } from "@melandlabs/indexeddb";

import type { MemoryStore } from "./index";
import type { PeerPosting } from "./search/peer-profile";

const DEFAULT_SCAN_LIMIT = 1000;

interface RawMessageLike {
	messageId?: string;
	id?: string | number;
	peer?: Peer;
	person?: string;
	userId?: string;
	metadata?: Record<string, unknown>;
	archivedAt?: number;
	deprecatedAt?: number;
	timestamp?: number;
}

interface RawMessageQueryLike {
	userId?: string;
	startTime?: number;
	endTime?: number;
	limit?: number;
	includeArchived?: boolean;
	includeDeprecated?: boolean;
}

interface StorageManagerLike extends Pick<RawMessageStorageManager, "queryMessages"> {}

/**
 * Resolve the author of a message to a structured `Peer`. When the ingest
 * path populated `message.peer` (which carries `kind`), that `kind` is
 * preserved — an agent author stays an agent. Bare `person` / `userId`
 * labels have no kind, so they fall back to `"user"` (the common case).
 */
function resolveAuthor(message: RawMessageLike): Peer | undefined {
	const peer = message.peer;
	if (peer && typeof peer.id === "string" && peer.id.length > 0) {
		return peer;
	}
	if (typeof message.person === "string" && message.person.length > 0) {
		return { kind: "user", id: message.person };
	}
	if (typeof message.userId === "string" && message.userId.length > 0) {
		return { kind: "user", id: message.userId };
	}
	return undefined;
}

function readMentions(message: RawMessageLike): ReadonlyArray<string> {
	const metadata = message.metadata;
	if (!metadata || typeof metadata !== "object") {
		return [];
	}
	const value = (metadata as Record<string, unknown>).mentions;
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function readStableId(message: RawMessageLike): string | undefined {
	if (typeof message.messageId === "string" && message.messageId.length > 0) {
		return message.messageId;
	}
	if (typeof message.id === "string" && message.id.length > 0) {
		return message.id;
	}
	return undefined;
}

async function fetchMessages(
	manager: StorageManagerLike,
	query: RawMessageQueryLike,
): Promise<RawMessageLike[]> {
	const result = await manager.queryMessages(
		query as unknown as Parameters<StorageManagerLike["queryMessages"]>[0],
	);
	return Array.isArray(result) ? (result as RawMessageLike[]) : [];
}

export interface ListKnownPeersOptions {
	/** Restrict the scan to a workspace / tenant namespace. */
	userId?: string;
	/** Inclusive lower bound on message timestamp (ms epoch). */
	startTime?: number;
	/** Inclusive upper bound on message timestamp (ms epoch). */
	endTime?: number;
	/** Maximum messages to scan (default: 1000). */
	scanLimit?: number;
	/** When true, archived / deprecated messages are included. */
	includeArchived?: boolean;
}

/**
 * Walk the raw-message store and return every distinct peer that
 * authored a message. Dedup is by `peerKey(peer)` so the same `(kind,
 * id)` pair is collapsed regardless of which channel / bot / episode
 * the message came from.
 *
 * If the host already keeps a peer directory (an accounts table, an
 * integration registry, etc.), prefer calling that directly and pass
 * the result to `createPeerProfile.listKnownPeers` — this helper is
 * only useful when the raw-message store is the source of truth.
 */
export async function listKnownPeersFromStore(
	store: MemoryStore,
	options: ListKnownPeersOptions = {},
): Promise<Peer[]> {
	const manager = (await store.raw.getManager()) as StorageManagerLike;
	const messages = await fetchMessages(manager, {
		userId: options.userId,
		startTime: options.startTime,
		endTime: options.endTime,
		limit: options.scanLimit ?? DEFAULT_SCAN_LIMIT,
		includeArchived: options.includeArchived ?? false,
	});

	const seen = new Map<string, Peer>();
	for (const message of messages) {
		const author = resolveAuthor(message);
		if (!author) continue;
		// `resolveAuthor` preserves `message.peer.kind` (user vs agent) when
		// present; bare `person` / `userId` fall back to "user". Hosts with a
		// peer directory can override by passing their own `listKnownPeers`.
		seen.set(peerKey(author), author);
	}
	return [...seen.values()];
}

export interface ListPeerMentionsOptions {
	userId: string;
	/** Inclusive lower bound on message timestamp (ms epoch). */
	startTime?: number;
	/** Inclusive upper bound on message timestamp (ms epoch). */
	endTime?: number;
	/** Maximum messages to scan (default: 1000). */
	scanLimit?: number;
	/** When true, archived / deprecated messages are included. */
	includeArchived?: boolean;
}

/**
 * Project the raw-message store onto the `PeerPosting[]` shape that
 * `createPeerProfile.listPeerMentions` expects. Messages without a
 * stable id, without an author, or with an empty mentions array are
 * dropped — `createPeerProfile` does not use them.
 */
export async function listPeerMentionsFromStore(
	store: MemoryStore,
	options: ListPeerMentionsOptions,
): Promise<PeerPosting[]> {
	if (!options || typeof options.userId !== "string" || options.userId.length === 0) {
		throw new Error("listPeerMentionsFromStore: options.userId is required");
	}
	const manager = (await store.raw.getManager()) as StorageManagerLike;
	const messages = await fetchMessages(manager, {
		userId: options.userId,
		startTime: options.startTime,
		endTime: options.endTime,
		limit: options.scanLimit ?? DEFAULT_SCAN_LIMIT,
		includeArchived: options.includeArchived ?? false,
	});

	const postings: PeerPosting[] = [];
	for (const message of messages) {
		const id = readStableId(message);
		const author = resolveAuthor(message);
		const authorId = author?.id;
		if (!id || !authorId) continue;
		const mentionedIds = readMentions(message);
		postings.push({
			id,
			authorId,
			...(mentionedIds.length > 0 ? { mentionedIds } : {}),
		});
	}
	return postings;
}
