/**
 * Tutorial: memory-consolidation primitives.
 *
 * Demonstrates the pure, LLM-free planning utilities from
 * `@melandlabs/memory-consolidation`:
 *
 *   - `buildMemoryEvidenceClusters` groups mock evidence records by a caller-defined key.
 *   - `buildMemoryRelationCandidates` discovers relation candidates from shared dimensions.
 *   - `buildMemoryConsolidationPlan` decides which clusters to preserve, observe, or decay.
 *
 * Run:
 *   cd examples
 *   node --experimental-strip-types src/tutorials/37-memory-consolidation-example.ts
 */

import {
	type MemoryEvidenceRecord,
	buildMemoryConsolidationPlan,
	buildMemoryEvidenceClusters,
	buildMemoryRelationCandidates,
} from "@melandlabs/memory-consolidation";
import { runIfMain } from "../_helpers.ts";

async function main() {
	// ---- Static surface checks ----
	console.log("Static surface checks:");
	console.log(
		`- buildMemoryEvidenceClusters is callable: ${typeof buildMemoryEvidenceClusters === "function"}`,
	);
	console.log(
		`- buildMemoryRelationCandidates is callable: ${typeof buildMemoryRelationCandidates === "function"}`,
	);
	console.log(
		`- buildMemoryConsolidationPlan is callable: ${typeof buildMemoryConsolidationPlan === "function"}`,
	);

	const now = Date.now();

	const records: MemoryEvidenceRecord[] = [
		{
			id: "rec-hiking-1",
			userId: "user-42",
			timestamp: now,
			tier: "mid",
			text: "User said they love hiking in the mountains on weekends.",
			accessCount: 2,
			dimensions: { topic: "hobby" },
		},
		{
			id: "rec-hiking-2",
			userId: "user-42",
			timestamp: now - 24 * 60 * 60 * 1000,
			tier: "mid",
			text: "User mentioned trail running and mountain hiking.",
			accessCount: 1,
			dimensions: { topic: "hobby" },
		},
		{
			id: "rec-work-1",
			userId: "user-42",
			timestamp: now - 2 * 24 * 60 * 60 * 1000,
			tier: "mid",
			text: "User has a project deadline tomorrow and is blocked on a bug.",
			accessCount: 5,
			dimensions: { topic: "work" },
		},
		{
			id: "rec-work-2",
			userId: "user-42",
			timestamp: now - 3 * 24 * 60 * 60 * 1000,
			tier: "mid",
			text: "User asked for a follow-up meeting about the API integration.",
			accessCount: 0,
			dimensions: { topic: "work" },
		},
	];

	// ---- Real API: evidence clustering ----
	console.log("\n--- buildMemoryEvidenceClusters ---");
	const clusters = buildMemoryEvidenceClusters({
		records,
		now,
		evidenceNorm: 2,
		getClusterKey: (record) => record.dimensions?.topic as string | undefined,
	});
	for (const cluster of clusters) {
		console.log(`- ${cluster.key}: ${cluster.evidenceCount} records, score=${cluster.score.toFixed(3)}`);
	}
	if (clusters.length !== 2) {
		throw new Error(`Expected 2 clusters, got ${clusters.length}`);
	}
	const hobbyCluster = clusters.find((c) => c.key === "hobby");
	const workCluster = clusters.find((c) => c.key === "work");
	if (!hobbyCluster || hobbyCluster.evidenceCount !== 2) {
		throw new Error("Expected hobby cluster with 2 records");
	}
	if (!workCluster || workCluster.evidenceCount !== 2) {
		throw new Error("Expected work cluster with 2 records");
	}

	// ---- Real API: relation candidates ----
	console.log("\n--- buildMemoryRelationCandidates ---");
	const candidates = buildMemoryRelationCandidates({
		records,
		maxRecordsPerKey: 10,
		maxCandidatesPerRecord: 4,
		scoreNorm: 1,
	});
	for (const candidate of candidates) {
		console.log(
			`- ${candidate.fromRecordId} <-> ${candidate.toRecordId}: keys=[${candidate.candidateKeys.join(", ")}]`,
		);
	}
	if (candidates.length < 2) {
		throw new Error(`Expected at least 2 relation candidates, got ${candidates.length}`);
	}
	const hasHobbyCandidate = candidates.some((c) => c.candidateKeys.some((k) => k.includes("topic:hobby")));
	const hasWorkCandidate = candidates.some((c) => c.candidateKeys.some((k) => k.includes("topic:work")));
	if (!hasHobbyCandidate || !hasWorkCandidate) {
		throw new Error("Expected candidates for both hobby and work topics");
	}

	// ---- Real API: consolidation plan ----
	console.log("\n--- buildMemoryConsolidationPlan ---");
	const plan = buildMemoryConsolidationPlan({
		records,
		now,
		evidenceNorm: 2,
		getClusterKey: (record) => record.dimensions?.topic as string | undefined,
		getCompetitionKey: (cluster) => cluster.key,
		thresholds: {
			preserveScore: 0,
			preserveEvidence: 1,
			decayScore: 0,
			decayEvidence: 0,
			competitionMargin: 0,
		},
	});
	console.log(`- entries: ${plan.entries.length}`);
	console.log(`- preserve: ${plan.actions.preserve.length}`);
	console.log(`- observe: ${plan.actions.observe.length}`);
	console.log(`- decay: ${plan.actions.decay.length}`);

	if (plan.entries.length !== 2) {
		throw new Error(`Expected 2 plan entries, got ${plan.entries.length}`);
	}
	if (plan.actions.preserve.length !== 2) {
		throw new Error(`Expected 2 preserve entries, got ${plan.actions.preserve.length}`);
	}
	if (plan.actions.observe.length !== 0 || plan.actions.decay.length !== 0) {
		throw new Error("Expected no observe/decay entries with lenient thresholds");
	}

	console.log("\n[OK] Memory consolidation tutorial completed");
}

export default main;

runIfMain("MemoryConsolidation tutorial", main, import.meta.url);
