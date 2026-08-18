/**
 * Peer-centric profile + relationship facade.
 *
 * A higher-level pattern over `UnifiedSearch` that turns the underlying
 * `search()` primitives into two question-shaped entry points a chat
 * assistant can answer on demand:
 *
 *   - `getProfile(peer)`     — synthesises a peer profile from the
 *     raw message tier (and any other tier the host enables).
 *   - `getRelationships(peer)` — discovers other peers co-mentioned
 *     with the target, confirms each via a pair-scoped
 *     `search()` call, and ranks by co-mention count.
 *
 * The facade is purely additive: it composes existing primitives and
 * never modifies `UnifiedSearch`. It assumes the host has already
 * wired `UnifiedSearchDeps` (raw messages, summaries, insights,
 * knowledge, peer-scope check, optional reranker, optional LLM).
 *
 * Host responsibilities:
 *   - provide a `listKnownPeers()` callback so the facade can resolve
 *     peer IDs to `Peer` records;
 *   - optionally provide a `listPeerMentions()` callback so the
 *     facade can enumerate co-mention candidates without scanning
 *     every message.
 */

import type { Peer } from "@melandlabs/contracts/peer";
import type { UnifiedSearch } from "./unified-search";

export interface PeerPosting {
	/** Stable identifier of the source posting (message ID, episode ID, ...). */
	id: string;
	/** ID of the peer who authored the posting. */
	authorId: string;
	/** IDs of peers mentioned in this posting (excludes the author). */
	mentionedIds?: ReadonlyArray<string>;
	/**
	 * Structured mentions (preferred over `mentionedIds`). Letting hosts pass
	 * full `Peer` records preserves `kind` (user vs agent) instead of
	 * collapsing every mention to a bare id that the resolver must guess at.
	 * Falls back to `mentionedIds` when omitted.
	 */
	mentionedPeers?: ReadonlyArray<Peer>;
}

export interface PeerProfileDeps {
	/** Underlying unified-search facade (provides `search`; legacy `searchUnifiedMemory` is a deprecated alias). */
	search: UnifiedSearch;
	/** Workspace / tenant namespace used for all underlying searches. */
	userId: string;
	/**
	 * Resolve a peer ID to the canonical `Peer` record. The facade
	 * uses this to convert string IDs from `PeerPosting` into the
	 * `Peer` instances passed to `peerFilter`. May be omitted if the
	 * host already returns `Peer` from `listKnownPeers` and prefers
	 * the facade to derive IDs from `peer.id`.
	 */
	resolvePeer?: (peerId: string) => Peer | undefined;
	/**
	 * All known peers the facade can answer queries about. Required.
	 */
	listKnownPeers: () => ReadonlyArray<Peer>;
	/**
	 * Enumerate every peer→peer co-mention edge observed in the
	 * corpus. The facade uses these to discover relationship
	 * candidates before confirming each one via
	 * `search()`. May return an async iterable for
	 * large corpora.
	 */
	listPeerMentions?: () => Promise<ReadonlyArray<PeerPosting>> | ReadonlyArray<PeerPosting>;
	/**
	 * Minimum similarity for the profile synthesis search. Defaults to
	 * `DEFAULT_PROFILE_THRESHOLD`. `0` widens recall (noisy); raise it to
	 * drop weakly-matching raw messages from the LLM context.
	 */
	profileThreshold?: number;
	/**
	 * Minimum similarity for the relationship confirmation search. Defaults
	 * to `DEFAULT_RELATIONSHIP_THRESHOLD`.
	 */
	relationshipThreshold?: number;
}

export interface PeerProfile {
	peer: Peer;
	/** LLM-synthesised answer (empty string when no LLM is configured or synthesis fails). */
	answer: string;
	/** Stable IDs of the evidence items the LLM saw. */
	evidenceIds: string[];
	/** Warning codes from the reflect pipeline (e.g. `reflect_llm_failed`). */
	warnings: string[];
}

export interface PeerRelationship {
	from: Peer;
	to: Peer;
	summary: string;
	evidenceIds: string[];
	/** Number of co-mention observations between `from` and `to`. */
	strength: number;
}

export interface PeerProfileFacade {
	/** Synthesise a profile for `peerId` via `search({ synthesize: true })`. */
	getProfile(peerId: string): Promise<PeerProfile>;
	/** Discover and rank relationships `peerId` has with other peers. */
	getRelationships(peerId: string): Promise<PeerRelationship[]>;
	/** All peers the facade knows about. */
	getKnownPeers(): ReadonlyArray<Peer>;
}

const DEFAULT_PROFILE_LIMIT = 20;
const DEFAULT_RELATIONSHIP_LIMIT = 5;
/**
 * Minimum similarity cut for the profile / relationship confirmation
 * searches. `0` widens recall but pulls in weakly-matching noise; hosts
 * can raise these via `PeerProfileDeps.profileThreshold` /
 * `relationshipThreshold` once their embedding space is calibrated.
 */
const DEFAULT_PROFILE_THRESHOLD = 0.1;
const DEFAULT_RELATIONSHIP_THRESHOLD = 0.1;

interface PeerCoOccurrence {
	count: number;
	evidenceIds: string[];
}

function indexKnownPeers(peers: ReadonlyArray<Peer>): Map<string, Peer> {
	const map = new Map<string, Peer>();
	for (const peer of peers) {
		map.set(peer.id, peer);
	}
	return map;
}

function resolvePeerFromMap(
	peerId: string,
	known: ReadonlyMap<string, Peer>,
	resolvePeer: ((peerId: string) => Peer | undefined) | undefined,
): Peer | undefined {
	if (resolvePeer) {
		const explicit = resolvePeer(peerId);
		if (explicit) return explicit;
	}
	return known.get(peerId);
}

function buildProfilePrompt(peerId: string): string {
	return `Summarize ${peerId}'s role, interests, and recent activity based on the evidence below.`;
}

function buildRelationshipPrompt(fromId: string, toId: string): string {
	return `How do ${fromId} and ${toId} interact? Describe the relationship.`;
}

async function collectMentions(
	postings: PeerProfileDeps["listPeerMentions"],
): Promise<ReadonlyArray<PeerPosting>> {
	if (!postings) return [];
	const result = postings();
	if (Array.isArray(result)) {
		return result;
	}
	return await result;
}

function collectCoMentions(
	postings: ReadonlyArray<PeerPosting>,
	targetId: string,
): Map<string, PeerCoOccurrence> {
	const coCounts = new Map<string, PeerCoOccurrence>();
	for (const posting of postings) {
		const mentionIds = posting.mentionedPeers?.map((p) => p.id) ?? posting.mentionedIds ?? [];
		const involvesTarget =
			posting.authorId === targetId ||
			mentionIds.includes(targetId) ||
			(posting.mentionedPeers ?? []).some((p) => p.id === targetId);
		if (!involvesTarget) {
			continue;
		}
		// Author who is not the target is itself a co-occurrence edge.
		if (posting.authorId !== targetId) {
			const entry = coCounts.get(posting.authorId) ?? { count: 0, evidenceIds: [] };
			entry.count += 1;
			entry.evidenceIds.push(posting.id);
			coCounts.set(posting.authorId, entry);
		}
		for (const otherId of mentionIds) {
			if (otherId === targetId) continue;
			const entry = coCounts.get(otherId) ?? { count: 0, evidenceIds: [] };
			entry.count += 1;
			entry.evidenceIds.push(posting.id);
			coCounts.set(otherId, entry);
		}
	}
	return coCounts;
}

export function createPeerProfile(deps: PeerProfileDeps): PeerProfileFacade {
	const { search, userId, resolvePeer, listKnownPeers } = deps;

	return {
		getKnownPeers() {
			return listKnownPeers();
		},

		async getProfile(peerId) {
			const known = indexKnownPeers(listKnownPeers());
			const peer = resolvePeerFromMap(peerId, known, resolvePeer);
			if (!peer) {
				throw new Error(`peer_profile: unknown peerId "${peerId}"`);
			}

			const out = await search.search({
				userId,
				query: buildProfilePrompt(peer.id),
				peerFilter: [peer],
				tiers: ["raw"],
				limit: DEFAULT_PROFILE_LIMIT,
				threshold: deps.profileThreshold ?? DEFAULT_PROFILE_THRESHOLD,
				synthesize: {
					responseSchema: { answer: "string", confidence: "number" },
				},
			});

			return {
				peer,
				answer: out.answer ?? "",
				evidenceIds: out.evidence.map((item) => item.id),
				warnings: out.warnings.map((warning) => warning.code),
			};
		},

		async getRelationships(peerId) {
			const known = indexKnownPeers(listKnownPeers());
			const peer = resolvePeerFromMap(peerId, known, resolvePeer);
			if (!peer) {
				throw new Error(`peer_profile: unknown peerId "${peerId}"`);
			}

			const postings = await collectMentions(deps.listPeerMentions);
			const coCounts = collectCoMentions(postings, peer.id);
			if (coCounts.size === 0) {
				return [];
			}

			const results: PeerRelationship[] = [];
			for (const [otherId, info] of coCounts) {
				const other = resolvePeerFromMap(otherId, known, resolvePeer);
				if (!other) continue;

				const confirmation = await search.search({
					userId,
					query: buildRelationshipPrompt(peer.id, other.id),
					peerFilter: [peer, other],
					sources: ["memory"],
					limit: DEFAULT_RELATIONSHIP_LIMIT,
					threshold: deps.relationshipThreshold ?? DEFAULT_RELATIONSHIP_THRESHOLD,
					mergeStrategy: "rrf",
				});

				// `info.evidenceIds` are co-mention posting IDs from `listPeerMentions`
				// (a corpus scan), which live in a different ID space than the live
				// `search()` hits below — filtering across the two never
				// matched. The confirmation search returns the resolvable memory
				// evidence, so use those IDs directly as the relationship evidence.
				const evidenceIds = confirmation.results.map((hit) => hit.id);

				results.push({
					from: peer,
					to: other,
					summary:
						confirmation.results.length > 0
							? `${confirmation.results.length} cross-mention${
									confirmation.results.length === 1 ? "" : "s"
								} between ${peer.id} and ${other.id}`
							: "no cross-mentions found",
					evidenceIds,
					strength: info.count,
				});
			}

			return results.sort((a, b) => b.strength - a.strength);
		},
	};
}
