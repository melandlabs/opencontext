/**
 * Tests for `@melandlabs/contracts/episode`. Episodes are the optional raw-event
 * envelope that a stream of `RawMessage` records belongs to. The contract is
 * intentionally narrow — duration, participants, and topic keys — so the
 * type-system test only needs to confirm assignment + omission works.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import type { Episode } from "./episode";

describe("Episode contract", () => {
	it("accepts a minimal episode payload (only required fields)", () => {
		const minimal: Episode = {
			episodeId: "ep-1",
			userId: "user-1",
			sourceChannel: "gmail",
			startedAt: 1_700_000_000_000,
		};
		expectTypeOf(minimal.endedAt).toEqualTypeOf<number | undefined>();
		expectTypeOf(minimal.participantIds).toEqualTypeOf<string[] | undefined>();
		expectTypeOf(minimal.topicKeys).toEqualTypeOf<string[] | undefined>();
		expectTypeOf(minimal.metadata).toEqualTypeOf<Record<string, unknown> | undefined>();
	});

	it("accepts a fully populated episode payload", () => {
		const full: Episode = {
			episodeId: "ep-2",
			userId: "user-1",
			sourceChannel: "slack",
			startedAt: 1_700_000_000_000,
			endedAt: 1_700_000_060_000,
			participantIds: ["u1", "u2"],
			summary: "Weekly planning",
			topicKeys: ["roadmap", "q4"],
			metadata: { threadRoot: "C123" },
		};
		expect(full.summary).toBe("Weekly planning");
		expect(full.metadata?.threadRoot).toBe("C123");
	});
});
