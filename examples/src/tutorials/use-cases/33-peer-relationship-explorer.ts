/**
 * Use case: research-lab collaboration explorer.
 *
 * A small research lab tracks its members through message traffic on
 * shared channels. The lab manager wants to answer three recurring
 * questions without manually reading every transcript:
 *
 *   1. "Who is X?"            → a synthesised profile of role, interests,
 *      and recent activity.
 *   2. "Who does X work with?" → peers co-mentioned with X, ranked by
 *      collaboration strength.
 *   3. "Who hasn't collaborated with anyone?" → isolated members that
 *      may need an introduction.
 *
 * Each function is a thin wrapper over the peer-profile facade. The
 * facade itself is purely additive on top of `UnifiedSearch`, so the
 * whole pipeline works against an in-memory mock backend — no sqlite,
 * no real embeddings, no API keys.
 */

import { createPeerProfile, createUnifiedSearch } from "@melandlabs/memory-store";
import type { Peer, PeerPosting } from "@melandlabs/contracts/peer";
import { runIfMain } from "../../_helpers.ts";

interface LabMessage {
	id: string;
	authorId: string;
	channel: "papers" | "eng" | "lab-chat";
	daysAgo: number;
	text: string;
	mentions?: string[];
}

const DAY = 1000 * 60 * 60 * 24;

const alice: Peer = { kind: "user", id: "alice" };
const bob: Peer = { kind: "user", id: "bob" };
const carol: Peer = { kind: "user", id: "carol" };
const dave: Peer = { kind: "user", id: "dave" };

// `dave` is deliberately absent from the corpus so we can demonstrate
// the "isolated researcher" path.

const NOW = Date.now();
const SEED: LabMessage[] = [
	{
		id: "p1",
		authorId: "alice",
		channel: "papers",
		daysAgo: 60,
		text: "Drafted a follow-up on retrieval-augmented agents. Bob reviewed the eval section.",
		mentions: ["bob"],
	},
	{
		id: "p2",
		authorId: "bob",
		channel: "papers",
		daysAgo: 58,
		text: "Pushed back on the leaderboard numbers — let's rerun with the new prompt set. Alice agreed.",
		mentions: ["alice"],
	},
	{
		id: "p3",
		authorId: "alice",
		channel: "lab-chat",
		daysAgo: 30,
		text: "Carol's new re-ranker experiments are showing real gains on the long-context slice.",
		mentions: ["carol"],
	},
	{
		id: "p4",
		authorId: "carol",
		channel: "lab-chat",
		daysAgo: 28,
		text: "Pairing with Alice on retrieval eval and Bob on the storage layer this week.",
		mentions: ["alice", "bob"],
	},
	{
		id: "p5",
		authorId: "bob",
		channel: "eng",
		daysAgo: 20,
		text: "Kicked off the storage migration. Alice is helping scope the search-side changes.",
		mentions: ["alice"],
	},
	{
		id: "p6",
		authorId: "alice",
		channel: "eng",
		daysAgo: 10,
		text: "Anyone read 'Designing Data-Intensive Applications'? Bob has been pushing me to pick it up.",
		mentions: ["bob"],
	},
];

const PEER_POSTINGS: PeerPosting[] = SEED.map((m) => ({
	id: m.id,
	authorId: m.authorId,
	mentionedIds: m.mentions ?? [],
}));

// ---- Mock backend ----

function fakeEmbed(text: string): number[] {
	const dim = 8;
	const v = new Array(dim).fill(0);
	for (let i = 0; i < text.length; i += 1) v[i % dim] += text.charCodeAt(i) / 255;
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

type UnifiedSearchDeps = Parameters<typeof createUnifiedSearch>[0];

function buildBackend(): UnifiedSearchDeps {
	return {
		embedQuery: async ({ query }) => fakeEmbed(query),
		searchRawMessagesAnn: async ({ queryEmbedding, limit, threshold }) =>
			SEED.map((m) => ({
				type: "memory" as const,
				id: m.id,
				content: m.text,
				similarity: cosine(queryEmbedding, fakeEmbed(m.text)),
				metadata: {
					peerId: m.authorId,
					mentions: m.mentions ?? [],
					channel: m.channel,
					timestamp: NOW - m.daysAgo * DAY,
				},
			}))
				.filter((hit) => hit.similarity >= threshold)
				.sort((a, b) => b.similarity - a.similarity)
				.slice(0, limit),
		searchRawMessagesLexical: async ({ keywords, limit }) => {
			const lowered = keywords.map((k) => k.toLowerCase());
			return SEED.map((m) => {
				const text = m.text.toLowerCase();
				const overlap = lowered.reduce((sum, kw) => sum + (text.includes(kw) ? 1 : 0), 0);
				return {
					type: "memory" as const,
					id: m.id,
					content: m.text,
					similarity: overlap / Math.max(lowered.length, 1),
					metadata: {
						peerId: m.authorId,
						mentions: m.mentions ?? [],
						channel: m.channel,
						timestamp: NOW - m.daysAgo * DAY,
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
					answer: `${target}: synthesised from ${evidenceCount} evidence item(s).`,
					confidence: 0.8,
				});
			},
		},
	};
}

async function main() {
	console.log("🧪 Research-lab collaboration explorer\n");

	const search = createUnifiedSearch(buildBackend());
	const facade = createPeerProfile({
		search,
		userId: "lab-workspace",
		listKnownPeers: () => [alice, bob, carol, dave],
		listPeerMentions: () => PEER_POSTINGS,
	});

	// ---- 1. Who is X? ----
	async function getCollaboratorProfile(name: string) {
		const profile = await facade.getProfile(name);
		console.log(`\n👤 Profile for ${name}:`);
		console.log(`   summary: ${profile.answer}`);
		console.log(`   backed by ${profile.evidenceIds.length} evidence item(s)`);
		if (profile.warnings.length > 0) {
			console.log(`   warnings: ${profile.warnings.join(", ")}`);
		}
		return profile;
	}

	await getCollaboratorProfile("alice");
	await getCollaboratorProfile("bob");

	// ---- 2. Who does X work with? ----
	async function findFrequentCollaborators(name: string) {
		const relationships = await facade.getRelationships(name);
		console.log(`\n🤝 Frequent collaborators of ${name}:`);
		if (relationships.length === 0) {
			console.log("   (no co-mentions observed)");
			return relationships;
		}
		for (const r of relationships) {
			console.log(`   - ${r.to.id}  ·  strength=${r.strength}  ·  ${r.summary}`);
		}
		return relationships;
	}

	const alicePartners = await findFrequentCollaborators("alice");
	const carolPartners = await findFrequentCollaborators("carol");

	// ---- 3. Who is isolated? ----
	function identifyIsolatedResearchers(peers: ReadonlyArray<Peer>) {
		const isolated: Peer[] = [];
		for (const peer of peers) {
			const authored = PEER_POSTINGS.some((p) => p.authorId === peer.id);
			const mentioned = PEER_POSTINGS.some((p) => (p.mentionedIds ?? []).includes(peer.id));
			if (!authored && !mentioned) {
				isolated.push(peer);
			}
		}
		return isolated;
	}

	console.log("\n🛰️  Isolated researchers (no messages authored or mentioned):");
	const isolated = identifyIsolatedResearchers(facade.getKnownPeers());
	if (isolated.length === 0) {
		console.log("   (everyone is connected)");
	} else {
		for (const peer of isolated) {
			console.log(`   - ${peer.kind}:${peer.id}`);
		}
	}

	// ---- Sanity assertions ----
	if (alicePartners.length === 0) {
		throw new Error("Expected alice to have at least one collaborator");
	}
	const alicePartnerIds = new Set(alicePartners.map((r) => r.to.id));
	if (!alicePartnerIds.has("bob")) {
		throw new Error("Expected bob to appear in alice's collaborator list");
	}
	if (carolPartners.length === 0) {
		throw new Error("Expected carol to have at least one collaborator");
	}
	if (isolated.find((p) => p.id !== "dave")) {
		throw new Error("Only dave should be flagged as isolated");
	}

	console.log("\n[OK] Research-lab collaboration explorer completed");
}

export default main;
runIfMain("peer-relationship-explorer", main, import.meta.url);