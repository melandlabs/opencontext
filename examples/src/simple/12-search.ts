/**
 * demo: @melandlabs/search — real-time query routing.
 *
 * `needsRealTimeInfo(query)` is a cheap, synchronous classifier used to
 * decide whether a question actually warrants a web search. Questions
 * with stable answers ("who wrote Hamlet?") are answered from the
 * model's own weights; questions about now ("weather in Tokyo right
 * now") get routed to the search backend. Skipping the lookup when it
 * isn't needed saves both latency and API quota.
 *
 * The live `search()` call needs `BRAVE_SEARCH_API_KEY`. Without it the
 * network half is skipped, but the routing logic above still runs — that
 * is the part most callers actually integrate against.
 */

import { needsRealTimeInfo, search } from "@melandlabs/search";
import { info, makeCheckWithSkip, runSection } from "../_helpers.ts";

/** Queries whose answers change by the hour. */
const TIME_SENSITIVE = [
	"What is the weather in Tokyo right now?",
	"latest news on AI regulation",
	"stock price of AAPL today",
];

/** Queries with stable answers — no lookup required. */
const TIMELESS = ["Who wrote Hamlet?", "what is 2+2", "Explain the Pythagorean theorem"];

export default async function demoSearch() {
	await runSection("demo: @melandlabs/search", async () => {
		const { check, skip } = makeCheckWithSkip("demo/search");

		for (const q of [...TIME_SENSITIVE, ...TIMELESS]) {
			info(
				"demo/search",
				`needsRealTimeInfo = ${String(needsRealTimeInfo(q)).padEnd(5)} ${JSON.stringify(q)}`,
			);
		}

		check(
			"every time-sensitive query is routed to search",
			TIME_SENSITIVE.every((q) => needsRealTimeInfo(q) === true),
			`${TIME_SENSITIVE.length} queries`,
		);
		check(
			"no timeless query triggers an unnecessary lookup",
			TIMELESS.every((q) => needsRealTimeInfo(q) === false),
			`${TIMELESS.length} queries`,
		);
		check(
			"the classifier returns a boolean, never a promise",
			typeof needsRealTimeInfo("hello") === "boolean",
		);
		check("an empty query does not need a lookup", needsRealTimeInfo("") === false);

		// The live lookup, only when a key is configured.
		if (!process.env.BRAVE_SEARCH_API_KEY) {
			skip("search()", "BRAVE_SEARCH_API_KEY is not set — no live web request made");
			return;
		}

		const results = await search("what is the OpenContext runtime substrate?");
		info("demo/search", `live search returned ${Array.isArray(results) ? results.length : "?"} result(s)`);
		check("search() resolves to an array of results", Array.isArray(results));
	});
}
