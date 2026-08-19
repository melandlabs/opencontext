/**
 * Peer-profile facade tests.
 *
 * Uses an in-memory mock backend (no sqlite / real embeddings) so the
 * facade contract can be verified in isolation. The mock mirrors the
 * shape of `UnifiedSearchDeps` consumed by `createUnifiedSearch` in
 * production: peer-aware filtering, lexical + ANN paths, a
 * deterministic LLM `complete` callback.
 */

import type { Peer } from "@melandlabs/contracts/peer";
import { describe, expect, it } from "vitest";

import type { UnifiedSearchDeps } from "../config";
import { type PeerPosting, createPeerProfile } from "./peer-profile";
import { IdentityReranker } from "./reranker";
import { createUnifiedSearch } from "./unified-search";

const NOW = Date.parse("2026-08-18T12:00:00Z");

interface SeedMessage {
	id: string;
	peerId: string;
	content: string;
	channel: string;
	timestamp: number;
	mentions?: string[];
}

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
		reranker: new IdentityReranker(),
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

function setup() {
	const deps = buildBackend();
	const search = createUnifiedSearch(deps);
	const facade = createPeerProfile({
		search,
		userId: "workspace-1",
		listKnownPeers: () => [alice, bob, carol],
		listPeerMentions: () => PEER_POSTINGS,
	});
	return { facade, deps };
}

describe("createPeerProfile", () => {
	it("exposes the configured known peers", () => {
		const { facade } = setup();
		expect(
			facade
				.getKnownPeers()
				.map((p) => p.id)
				.sort(),
		).toEqual(["alice", "bob", "carol"]);
	});

	it("synthesises a profile via reflect() and records evidence ids", async () => {
		const { facade } = setup();
		const profile = await facade.getProfile("alice");
		expect(profile.peer).toEqual(alice);
		expect(profile.answer).toMatch(/^alice:/);
		expect(profile.evidenceIds.length).toBeGreaterThan(0);
		expect(profile.warnings).not.toContain("reflect_llm_failed");
	});

	it("throws on unknown peer ids", async () => {
		const { facade } = setup();
		await expect(facade.getProfile("nobody")).rejects.toThrow(/unknown peerId/);
	});

	it("discovers relationships by co-mention and confirms each via unified search", async () => {
		const { facade } = setup();
		const relationships = await facade.getRelationships("alice");
		const partners = relationships.map((r) => r.to.id).sort();
		expect(partners).toEqual(["bob", "carol"]);

		const bob = relationships.find((r) => r.to.id === "bob");
		expect(bob?.strength).toBeGreaterThanOrEqual(2);
		expect(bob?.evidenceIds.length).toBeGreaterThan(0);
		expect(bob?.summary).toMatch(/cross-mention/);
	});

	it("returns an empty relationship list when no peer mentions the target", async () => {
		setup();
		const empty = createPeerProfile({
			search: createUnifiedSearch(buildBackend()),
			userId: "workspace-1",
			listKnownPeers: () => [alice],
			listPeerMentions: () => [],
		});
		const result = await empty.getRelationships("alice");
		expect(result).toEqual([]);
	});

	it("honours an explicit resolvePeer callback over the known-peers map", async () => {
		const deps = buildBackend();
		const search = createUnifiedSearch(deps);
		const customAlice: Peer = { kind: "agent", id: "alice" };
		const facade = createPeerProfile({
			search,
			userId: "workspace-1",
			listKnownPeers: () => [],
			resolvePeer: (id) => (id === "alice" ? customAlice : undefined),
			listPeerMentions: () => PEER_POSTINGS,
		});
		const profile = await facade.getProfile("alice");
		expect(profile.peer).toEqual(customAlice);
	});
});
