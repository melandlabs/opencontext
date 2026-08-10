/**
 * @melandlabs/search smoke test.
 *
 * The search package exposes a Brave search adapter plus an entry-level
 * helper. We only verify imports + the function shape; we do not hit the
 * Brave API (it would need a key).
 */

import * as search from "@melandlabs/search";
import { makeCheck, runSection } from "./_helpers.ts";

export default async function testSearch() {
	await runSection("@melandlabs/search", async () => {
		const check = makeCheck("search");
		const exported = Object.keys(search).filter((k) => !k.startsWith("_"));
		check("module exports symbols", exported.length > 0);

		const maybeSearch = (search as Record<string, unknown>).search;
		check("search function is exported", typeof maybeSearch === "function");
		check(
			"search.needsRealTimeInfo is a function",
			typeof search.needsRealTimeInfo === "function",
		);

		const realTime = search.needsRealTimeInfo(
			"What's the weather in Tokyo right now?",
		);
		check("needsRealTimeInfo returns boolean", typeof realTime === "boolean");
	});
}
