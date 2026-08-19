/**
 * Peer abstraction — structured identity for actors in a conversation.
 *
 * A `Peer` is the unified identity model that supersedes ad-hoc
 * `userId` / `botId` strings. The contract is intentionally minimal so
 * it can be embedded in higher-level envelopes (`Episode.peerIds`,
 * `Decision.decidedByPeer`, `RawMessage.peer`) without dragging any
 * platform-specific schema along.
 *
 * Conventions:
 *
 *   - `kind: "user"` represents a human account.
 *   - `kind: "agent"` represents an AI / bot / assistant identity.
 *   - `id` is the platform-agnostic identifier under that kind.
 *
 * The `peerKey` form (`"user:42"`, `"agent:bot-7"`) is the canonical
 * serialization used by storage layers and log lines. It round-trips
 * losslessly through `parsePeerKey`.
 *
 * `asPeer` / `asPeers` are boundary helpers that lift loose strings into
 * the structured form. They do not perform authentication; callers
 * remain responsible for verifying that a string refers to a real
 * peer.
 */

export type PeerKind = "user" | "agent";

export interface Peer {
	kind: PeerKind;
	id: string;
}

export const PEER_KINDS: readonly PeerKind[] = ["user", "agent"] as const;

const PEER_KEY_SEP = ":";

function isValidKind(value: unknown): value is PeerKind {
	return value === "user" || value === "agent";
}

export function isPeerKind(value: unknown): value is PeerKind {
	return isValidKind(value);
}

export function isPeer(value: unknown): value is Peer {
	if (!value || typeof value !== "object") {
		return false;
	}
	const item = value as Record<string, unknown>;
	return isValidKind(item.kind) && typeof item.id === "string" && item.id.length > 0;
}

/**
 * Canonical string form of a peer. Two peers with the same `(kind, id)`
 * serialize to the same key. The colon separator is reserved — peer ids
 * that contain a colon are not supported by this encoding.
 */
export function peerKey(peer: Peer): string {
	return `${peer.kind}${PEER_KEY_SEP}${peer.id}`;
}

/**
 * Inverse of {@link peerKey}. Returns `undefined` when the input is not
 * a well-formed key so callers can use it for untrusted input without
 * try/catch.
 */
export function parsePeerKey(key: string): Peer | undefined {
	if (typeof key !== "string") {
		return undefined;
	}
	const index = key.indexOf(PEER_KEY_SEP);
	if (index <= 0 || index === key.length - 1) {
		return undefined;
	}
	const kind = key.slice(0, index);
	const id = key.slice(index + 1);
	if (!isValidKind(kind)) {
		return undefined;
	}
	if (id.length === 0) {
		return undefined;
	}
	return { kind, id };
}

/**
 * Lift a loose string into a structured `Peer`. The caller picks the
 * `kind` explicitly so the same string under different namespaces
 * (e.g. `"42"` as a user vs `"42"` as an agent id) can be distinguished.
 * Defaults to `"user"` for the common case of human identifiers.
 */
export function asPeer(value: string, kind: PeerKind = "user"): Peer {
	return { kind, id: value };
}

/**
 * Lift a list of loose strings. Empty / whitespace-only entries are
 * dropped silently — they have no meaningful `(kind, id)` representation.
 */
export function asPeers(values: ReadonlyArray<string>, kind: PeerKind = "user"): Peer[] {
	const out: Peer[] = [];
	for (const value of values) {
		if (typeof value !== "string") {
			continue;
		}
		const trimmed = value.trim();
		if (trimmed.length === 0) {
			continue;
		}
		out.push({ kind, id: trimmed });
	}
	return out;
}
