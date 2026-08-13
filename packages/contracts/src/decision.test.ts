/**
 * Tests for `@melandlabs/contracts/decision`. Decisions are first-class
 * artifacts representing a commitment the user (or their team) made. The
 * shape is intentionally minimal here — domain packages extend with workflow
 * state, approval chain, and provenance.
 */
import { describe, expect, it } from "vitest";

import type { Decision } from "./decision";

describe("Decision contract", () => {
	it("accepts the minimal required payload", () => {
		const minimal: Decision = {
			decisionId: "d-1",
			userId: "user-1",
			title: "Adopt Postgres",
			decidedAt: 1_700_000_000_000,
		};
		expect(minimal.title).toBe("Adopt Postgres");
		expect(minimal.rationale).toBeUndefined();
	});

	it("accepts a fully populated payload with optional traceability links", () => {
		const full: Decision = {
			decisionId: "d-2",
			userId: "user-1",
			title: "Migrate to v2",
			rationale: "Read perf + simpler ops",
			decidedAt: 1_700_000_000_000,
			decidedBy: "user-1",
			outcome: "shipped",
			relatedEpisodeIds: ["ep-1", "ep-2"],
			relatedRecordIds: ["rec-1"],
			metadata: { jiraIssue: "OPS-42" },
		};
		expect(full.relatedEpisodeIds).toHaveLength(2);
		expect(full.metadata?.jiraIssue).toBe("OPS-42");
	});
});
