/**
 * demo: @melandlabs/memory-store — peer-centric profile + relationships.
 *
 * A higher-level pattern over `UnifiedSearch`: turn the underlying
 * `reflect()` and `searchUnifiedMemory()` primitives into two
 * question-shaped entry points a chat assistant can answer on demand:
 *
 *   1. "What's Alice like?"   → `getProfile(peer)`  (LLM-synthesised answer
 *      + the evidence IDs the LLM saw).
 *   2. "Who does Alice know?" → `getRelationships(peer)`  (co-mention
 *      edges, each confirmed via a pair-scoped recall + ranked by
 *      co-mention count).
 *
 * The demo seeds a small three-peer corpus (alice / bob / carol) and
 * drives `createPeerProfile` against a peer-aware in-memory backend —
 * no SQLite, no real embeddings. The mock LLM is deterministic: it
 * counts the bracketed evidence markers in the prompt and lifts the
 * query target into the answer text, which lets us assert on the
 * whole pipeline without a real model.
 *
 * The point of this demo is to keep an executable guard in front of
 * the peer-profile facade so a regression in either `reflect()`
 * integration, the relationships edge discovery, or the evidence
 * round-trip surfaces in `pnpm test`.
 */

import type { Peer } from "@melandlabs/contracts/peer";
import {
	createPeerProfile,
	createUnifiedSearch,
	type PeerPosting,
	type UnifiedSearchDeps,
} from "@melandlabs/memory-store";
import { info, makeCheck, runSection } from "../_helpers.ts";

// ─── 1. Seed data ─────────────────────────────────────────────────────────

interface SeedMessage {
	id: string;
	peerId: "alice" | "bob" | "carol";
	content: string;
	channel: string;
	timestamp: number;
	mentions?: Array<"alice" | "bob" | "carol">;
}

const alice: Peer = { kind: "user", id: "alice" };
const bob: Peer = { kind: "user", id: "bob" };
const carol: Peer = { kind: "user", id: "carol" };
const peersById = { alice, bob, carol } as const;

const NOW = Date.parse("2026-08-18T12:00:00Z");
const SEED_MESSAGES: SeedMessage[] = [
	{
		id: "m1",
		peerId: "alice",
		channel: "team-engineering",
		timestamp: NOW - 1000 * 60 * 60 * 24 * 30,
		content:
			"I've been leading the migration to the new search index this quarter. Bob has been a great partner for the infra side.",
		mentions: ["bob"],
	},
	{
		id: "m2",
		peerId: "bob",
		channel: "team-engineering",
		timestamp: NOW - 1000 * 60 * 60 * 24 * 29,
		content:
			"Agreed — Alice drives the search rewrite and I handle the storage layer. We pair on the schema every Friday.",
		mentions: ["alice"],
	},
	{
		id: "m3",
		peerId: "alice",
		channel: "team-engineering",
		timestamp: NOW - 1000 * 60 * 60 * 24 * 20,
		content: "Carol joined as our new ML engineer last week. She'll take over the re-ranker experiments.",
		mentions: ["carol"],
	},
	{
		id: "m4",
		peerId: "carol",
		channel: "team-engineering",
		timestamp: NOW - 1000 * 60 * 60 * 24 * 18,
		content:
			"Excited to be here. I'll be working closely with Alice on retrieval and with Bob on the eval pipeline.",
		mentions: ["alice", "bob"],
	},
	{
		id: "m5",
		peerId: "alice",
		channel: "design-bookclub",
		timestamp: NOW - 1000 * 60 * 60 * 24 * 12,
		content:
			"Anyone read 'Designing Data-Intensive Applications'? Bob recommended it last year and it changed how I write service code.",
		mentions: ["bob"],
	},
	{
		id: "m6",
		peerId: "bob",
		channel: "design-bookclub",
		timestamp: NOW - 1000 * 60 * 60 * 24 * 11,
		content: "Glad you liked it, Alice. Carol, you'll probably love chapter 9 — it's all about consistency.",
		mentions: ["alice", "carol"],
	},
	{
		id: "m7",
		peerId: "alice",
		channel: "team-engineering",
		timestamp: NOW - 1000 * 60 * 60 * 24 * 5,
		content:
			"Wrapping up the search migration next week. Big thanks to Carol for the re-ranker wins — recall is up 18%.",
		mentions: ["carol"],
	},
	{
		id: "m8",
		peerId: "carol",
		channel: "team-engineering",
		timestamp: NOW - 1000 * 60 * 60 * 24 * 4,
		content:
			"Thanks Alice! Couldn't have done it without the eval harness Bob built. The whole team clicked this quarter.",
		mentions: ["alice", "bob"],
	},
	{
		id: "m9",
		peerId: "bob",
		channel: "team-engineering",
		timestamp: NOW - 1000 * 60 * 60 * 24 * 2,
		content:
			"Shipping the migration tomorrow. Alice, want to do the on-call rotation with me for the first week?",
		mentions: ["alice"],
	},
];

const KNOWN_PEER_IDS: ReadonlyArray<SeedMessage["peerId"]> = ["alice", "bob", "carol"];

const PEER_POSTINGS: PeerPosting[] = SEED_MESSAGES.map((m) => ({
	id: m.id,
	authorId: m.peerId,
	mentionedIds: m.mentions ?? [],
}));

// ─── 2. In-memory backend (mock) ──────────────────────────────────────────

const EMBEDDING_DIM = 8;

function fakeEmbed(text: string): number[] {
	const v = new Array(EMBEDDING_DIM).fill(0);
	for (let i = 0; i < text.length; i += 1) {
		v[i % EMBEDDING_DIM] += text.charCodeAt(i) / 255;
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
		// No explicit reranker — the unified-search facade falls back to its
		// built-in identity reranker (preserves order) when none is wired.
		reasoning: {
			defaultMergeStrategy: "rrf",
			// Deterministic mock LLM: counts the bracketed evidence markers
			// in the prompt and lifts the query target into the answer
			// text. Lets us assert the full profile pipeline without a
			// real model.
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

// ─── 3. Wire the SDK facade ───────────────────────────────────────────────

function setupFacade() {
	const search = createUnifiedSearch(buildBackend());
	return createPeerProfile({
		search,
		userId: "workspace-1",
		listKnownPeers: () => [alice, bob, carol],
		listPeerMentions: () => PEER_POSTINGS,
	});
}

// ─── 4. Demo runner with assertions ───────────────────────────────────────

export default async function demoPeerProfile() {
	await runSection("demo: @melandlabs/memory-store — peer-profile facade", async () => {
		const check = makeCheck("demo/peer-profile");

		const facade = setupFacade();

		info(
			"demo/peer-profile",
			`seeded ${SEED_MESSAGES.length} messages across ${KNOWN_PEER_IDS.length} peers`,
		);

		// ----- 1. Profile for each peer -----
		for (const peerId of KNOWN_PEER_IDS) {
			const peer = peersById[peerId];
			const profile = await facade.getProfile(peerId);
			const relationships = await facade.getRelationships(peerId);

			info(`demo/peer-profile/${peer.id}`, `answer="${profile.answer}"`);
			info(
				`demo/peer-profile/${peer.id}`,
				`evidence=${profile.evidenceIds.length} [${profile.evidenceIds.join(", ")}]`,
			);
			if (profile.warnings.length > 0) {
				info(`demo/peer-profile/${peer.id}`, `warnings=${profile.warnings.join(", ")}`);
			}
			for (const rel of relationships) {
				info(
					`demo/peer-profile/${peer.id}`,
					`→ ${rel.to.id} strength=${rel.strength} evidence=[${rel.evidenceIds.join(", ")}]`,
				);
			}
		}

		// ----- 2. Assertions on the alice pipeline -----
		const aliceProfile = await facade.getProfile("alice");
		const aliceRelationships = await facade.getRelationships("alice");
		const carolRelationships = await facade.getRelationships("carol");
		const bobRelationships = await facade.getRelationships("bob");

		check(
			"alice's profile pulls ≥3 evidence items",
			aliceProfile.evidenceIds.length >= 3,
			String(aliceProfile.evidenceIds.length),
		);
		check(
			"alice's profile did not record an LLM failure",
			!aliceProfile.warnings.some((w) => w === "reflect_llm_failed"),
			aliceProfile.warnings.join(", ") || "none",
		);
		check(
			"alice has a recorded relationship to bob",
			aliceRelationships.some((r) => r.to.id === "bob"),
		);
		check(
			"alice has a recorded relationship to carol",
			aliceRelationships.some((r) => r.to.id === "carol"),
		);
		check(
			"carol has a recorded relationship to alice",
			carolRelationships.some((r) => r.to.id === "alice"),
		);
		check(
			"bob has a recorded relationship to alice",
			bobRelationships.some((r) => r.to.id === "alice"),
		);
		check(
			"alice ↔ bob has strength ≥2 (multiple co-mentions)",
			(aliceRelationships.find((r) => r.to.id === "bob")?.strength ?? 0) >= 2,
			String(aliceRelationships.find((r) => r.to.id === "bob")?.strength ?? 0),
		);
		check("profile answer mentions 'alice'", aliceProfile.answer.startsWith("alice:"), aliceProfile.answer);
		check(
			"profile pulled either all 9 cross-mention messages or 4 own messages",
			aliceProfile.evidenceIds.length === 9 || aliceProfile.evidenceIds.length === 4,
			String(aliceProfile.evidenceIds.length),
		);
	});
}
