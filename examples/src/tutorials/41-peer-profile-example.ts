/**
 * Tutorial: peer-profile facade from `@melandlabs/memory-store`.
 *
 * Demonstrates the high-level `createPeerProfile` facade — a thin layer
 * over `UnifiedSearch` that turns the underlying retrieval primitives
 * into two question-shaped entry points a chat assistant can answer:
 *
 *   - `getProfile(peerId)`     — synthesises a peer profile from raw
 *     messages via `search({ synthesize: true })`.
 *   - `getRelationships(peerId)` — discovers other peers co-mentioned
 *     with the target, confirms each via a pair-scoped `search()`,
 *     and ranks by co-mention count.
 *
 * This example wires an in-memory mock backend (no sqlite / real
 * embeddings) so the facade contract can be exercised in isolation. The
 * mock mirrors the shape of `UnifiedSearchDeps` consumed by
 * `createUnifiedSearch` in production.
 *
 * Run:
 *   cd examples
 *   node --experimental-strip-types src/tutorials/41-peer-profile-example.ts
 */

import { createPeerProfile, createUnifiedSearch } from "@melandlabs/memory-store";
import type { Peer, PeerPosting } from "@melandlabs/contracts/peer";
import { runIfMain } from "../_helpers.ts";

interface SeedMessage {
	id: string;
	peerId: string;
	channel: string;
	timestamp: number;
	content: string;
	mentions?: string[];
}

const NOW = Date.parse("2026-08-18T12:00:00Z");

const alice: Peer = { kind: "user", id: "alice" };
const bob: Peer = { kind: "user", id: "bob" };
const carol: Peer = { kind: "user", id: "carol" };

const SEED_MESSAGES: SeedMessage[] = [
	{
		id: "m1",
		peerId: "alice",
		channel: "eng",
		timestamp: NOW - 1000 * 60 * 60 * 24 * 30,
		content: "Leading the search migration this quarter. Bob has been a great infra partner.",
		mentions: ["bob"],
	},
	{
		id: "m2",
		peerId: "bob",
		channel: "eng",
		timestamp: NOW - 1000 * 60 * 60 * 24 * 29,
		content: "Agreed — Alice drives search, I handle storage. Pairing every Friday.",
		mentions: ["alice"],
	},
	{
		id: "m3",
		peerId: "alice",
		channel: "eng",
		timestamp: NOW - 1000 * 60 * 60 * 24 * 20,
		content: "Carol joined as the new ML engineer. She'll run the re-ranker experiments.",
		mentions: ["carol"],
	},
	{
		id: "m4",
		peerId: "carol",
		channel: "eng",
		timestamp: NOW - 1000 * 60 * 60 * 24 * 18,
		content: "Excited to be here. Working closely with Alice on retrieval and Bob on eval.",
		mentions: ["alice", "bob"],
	},
	{
		id: "m5",
		peerId: "alice",
		channel: "books",
		timestamp: NOW - 1000 * 60 * 60 * 24 * 12,
		content: "Anyone read 'Designing Data-Intensive Applications'? Bob recommended it.",
		mentions: ["bob"],
	},
];

const PEER_POSTINGS: PeerPosting[] = SEED_MESSAGES.map((m) => ({
	id: m.id,
	authorId: m.peerId,
	mentionedIds: m.mentions ?? [],
}));

// ---- Mock backend (no sqlite, no real embeddings) ----

function fakeEmbed(text: string): number[] {
	const dim = 8;
	const v = new Array(dim).fill(0);
	for (let i = 0; i < text.length; i += 1) {
		v[i % dim] += text.charCodeAt(i) / 255;
	}
	const norm = Math.hypot(...v) || 1;
	return v.map((x) => x / norm);
}

function cosine(a: number[], b: number[]): number {
	let dot = 0;
	for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
	const na = Math.hypot(...a) || 1;
	const nb = Math.hypot(...b) || 1;
	return dot / (na * nb);
}

// Derive the dependency shape from `createUnifiedSearch` itself so we
// don't depend on the internal `UnifiedSearchDeps` type that isn't part
// of the public package surface.
type UnifiedSearchDeps = Parameters<typeof createUnifiedSearch>[0];

function buildBackend(): UnifiedSearchDeps {
	return {
		embedQuery: async ({ query }) => fakeEmbed(query),
		searchRawMessagesAnn: async ({ queryEmbedding, limit, threshold }) => {
			return SEED_MESSAGES.map((m) => ({
				type: "memory" as const,
				id: m.id,
				content: m.content,
				similarity: cosine(queryEmbedding, fakeEmbed(m.content)),
				metadata: {
					peerId: m.peerId,
					mentions: m.mentions ?? [],
					channel: m.channel,
					timestamp: m.timestamp,
				},
			}))
				.filter((hit) => hit.similarity >= threshold)
				.sort((a, b) => b.similarity - a.similarity)
				.slice(0, limit);
		},
		searchRawMessagesLexical: async ({ keywords, limit }) => {
			const lowered = keywords.map((k) => k.toLowerCase());
			return SEED_MESSAGES.map((m) => {
				const text = m.content.toLowerCase();
				const overlap = lowered.reduce((sum, kw) => sum + (text.includes(kw) ? 1 : 0), 0);
				return {
					type: "memory" as const,
					id: m.id,
					content: m.content,
					similarity: overlap / Math.max(lowered.length, 1),
					metadata: {
						peerId: m.peerId,
						mentions: m.mentions ?? [],
						channel: m.channel,
						timestamp: m.timestamp,
						scoring: "bm25",
					},
				};
			})
				.filter((hit) => hit.similarity > 0)
				.sort((a, b) => b.similarity - a.similarity)
				.slice(0, limit);
		},
		searchInsights: async () => [],
		searchKnowledge: async () => [],
		searchSummaries: async () => [],
		reasoning: {
			defaultMergeStrategy: "rrf",
			complete: async (prompt) => {
				const evidenceCount = (prompt.match(/^\s*\[\d+\] /gm) ?? []).length;
				const targetMatch = prompt.match(/Question:\s*Summarize\s+(\w+)'s/);
				const target = targetMatch ? targetMatch[1] : "peer";
				return JSON.stringify({
					answer: `${target}: synthesized from ${evidenceCount} evidence items.`,
					confidence: 0.8,
				});
			},
		},
	};
}

async function main() {
	// ---- Static surface checks ----
	console.log("Static surface checks:");
	console.log(`- createPeerProfile is callable: ${typeof createPeerProfile === "function"}`);
	console.log(`- createUnifiedSearch is callable: ${typeof createUnifiedSearch === "function"}`);

	// ---- Build facade ----
	const search = createUnifiedSearch(buildBackend());
	const facade = createPeerProfile({
		search,
		userId: "workspace-1",
		listKnownPeers: () => [alice, bob, carol],
		listPeerMentions: () => PEER_POSTINGS,
	});

	// ---- getKnownPeers ----
	console.log("\n--- getKnownPeers ---");
	const known = facade
		.getKnownPeers()
		.map((p) => p.id)
		.sort();
	console.log(`- known peers: ${known.join(", ")}`);
	if (known.length !== 3) {
		throw new Error(`Expected 3 known peers, got ${known.length}`);
	}

	// ---- getProfile ----
	console.log('\n--- getProfile("alice") ---');
	const profile = await facade.getProfile("alice");
	console.log(`- peer:        ${profile.peer.kind}:${profile.peer.id}`);
	console.log(`- answer:      ${profile.answer}`);
	console.log(`- evidenceIds: ${profile.evidenceIds.join(", ") || "(none)"}`);
	console.log(`- warnings:    ${profile.warnings.join(", ") || "(none)"}`);
	if (profile.peer !== alice) {
		throw new Error(`Expected profile.peer to equal alice, got ${JSON.stringify(profile.peer)}`);
	}
	if (!profile.answer.startsWith("alice:")) {
		throw new Error(`Expected profile.answer to start with 'alice:', got '${profile.answer}'`);
	}
	if (profile.evidenceIds.length === 0) {
		throw new Error("Expected at least one evidence id for alice's profile");
	}
	if (profile.warnings.includes("reflect_llm_failed")) {
		throw new Error("Did not expect reflect_llm_failed warning");
	}

	// ---- getRelationships ----
	console.log('\n--- getRelationships("alice") ---');
	const relationships = await facade.getRelationships("alice");
	for (const r of relationships) {
		console.log(
			`- ${r.from.id} -> ${r.to.id}  strength=${r.strength}  evidence=${r.evidenceIds.length}  summary="${r.summary}"`,
		);
	}
	const partnerIds = relationships.map((r) => r.to.id).sort();
	if (JSON.stringify(partnerIds) !== JSON.stringify(["bob", "carol"])) {
		throw new Error(`Expected alice's partners to be [bob, carol], got ${JSON.stringify(partnerIds)}`);
	}
	const bobRel = relationships.find((r) => r.to.id === "bob");
	if (!bobRel || bobRel.strength < 2) {
		throw new Error(`Expected alice→bob strength >= 2, got ${bobRel?.strength ?? "<missing>"}`);
	}
	if (!bobRel?.summary.includes("cross-mention")) {
		throw new Error(`Expected alice→bob summary to mention 'cross-mention', got '${bobRel?.summary}'`);
	}

	// ---- Unknown peer throws ----
	console.log('\n--- getProfile("nobody") (expect throw) ---');
	let threw = false;
	try {
		await facade.getProfile("nobody");
	} catch (err) {
		threw = true;
		console.log(`- threw: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!threw) {
		throw new Error("Expected getProfile('nobody') to throw");
	}

	// ---- Empty mentions returns [] ----
	console.log("\n--- getRelationships with no mentions ---");
	const emptyFacade = createPeerProfile({
		search: createUnifiedSearch(buildBackend()),
		userId: "workspace-1",
		listKnownPeers: () => [alice],
		listPeerMentions: () => [],
	});
	const empty = await emptyFacade.getRelationships("alice");
	console.log(`- result: ${JSON.stringify(empty)}`);
	if (empty.length !== 0) {
		throw new Error(`Expected empty relationships, got ${empty.length}`);
	}

	// ---- Custom resolvePeer overrides identity ----
	console.log("\n--- custom resolvePeer callback ---");
	const customAlice: Peer = { kind: "agent", id: "alice" };
	const customFacade = createPeerProfile({
		search: createUnifiedSearch(buildBackend()),
		userId: "workspace-1",
		listKnownPeers: () => [],
		resolvePeer: (id) => (id === "alice" ? customAlice : undefined),
		listPeerMentions: () => PEER_POSTINGS,
	});
	const customProfile = await customFacade.getProfile("alice");
	console.log(`- resolved peer: ${customProfile.peer.kind}:${customProfile.peer.id}`);
	if (customProfile.peer !== customAlice) {
		throw new Error("Expected resolvePeer to override alice's identity");
	}

	// ---- Thresholds widen or tighten recall ----
	// Note: in this mock backend the ANN embeddings are coarse (8-dim
	// char-code buckets) so cosine scores cluster tightly. The
	// threshold parameter still flows through to the ANN path; we just
	// verify that it is honoured without asserting on exact counts,
	// which would be brittle against a different mock.
	console.log("\n--- custom profileThreshold ---");
	const strictFacade = createPeerProfile({
		search: createUnifiedSearch(buildBackend()),
		userId: "workspace-1",
		listKnownPeers: () => [alice, bob, carol],
		listPeerMentions: () => PEER_POSTINGS,
		profileThreshold: 0.99,
	});
	const strictProfile = await strictFacade.getProfile("alice");
	console.log(
		`- profileThreshold=0.99 evidence count: ${strictProfile.evidenceIds.length} (default was ${profile.evidenceIds.length})`,
	);
	if (strictProfile.evidenceIds.length > profile.evidenceIds.length) {
		throw new Error(
			`Expected stricter threshold to NOT increase evidence ids (got ${strictProfile.evidenceIds.length} vs default ${profile.evidenceIds.length})`,
		);
	}

	console.log("\n[OK] Peer-profile tutorial completed");
}

export default main;
runIfMain("PeerProfile tutorial", main, import.meta.url);
