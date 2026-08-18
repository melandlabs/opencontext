/**
 * Tutorial: search intent detection with `@melandlabs/opencontext`.
 *
 * This example demonstrates the web-search exports of the OpenContext facade:
 *
 *   - `needsRealTimeInfo` — classify whether a natural-language query likely
 *     requires up-to-date information from the web.
 *
 * The tutorial prints static surface checks and classifies a small batch of
 * representative queries. Live web search is intentionally skipped unless the
 * `BRAVE_SEARCH_API_KEY` environment variable is set, so the example is safe to
 * run without any API credentials.
 *
 * Run:
 *   cd examples
 *   node --experimental-strip-types src/tutorials/33-search-example.ts
 */

import process from "node:process";
import { type WebSearchResult, needsRealTimeInfo, search } from "@melandlabs/opencontext";
import { runIfMain } from "../_helpers.ts";

async function main() {
	// ---- Static surface checks ----
	console.log("Static surface checks:");
	console.log(`- needsRealTimeInfo is callable: ${typeof needsRealTimeInfo === "function"}`);
	console.log(`- search is callable: ${typeof search === "function"}`);

	// ---- Intent classification ----
	console.log("\n--- Query classification ---");
	const queries = [
		{ text: "What is the capital of France?", expected: false },
		{ text: "What is the weather today?", expected: true },
		{ text: "Explain quantum computing", expected: false },
		{ text: "Latest news on Mars exploration", expected: true },
		{ text: "How do I make sourdough bread?", expected: false },
		{ text: "Current stock price of Apple", expected: true },
	];

	let mismatches = 0;
	for (const { text, expected } of queries) {
		const result = needsRealTimeInfo(text);
		const ok = result === expected;
		console.log(`- "${text}" -> ${result} ${ok ? "✓" : `✗ (expected ${expected})`}`);
		if (!ok) {
			mismatches += 1;
		}
	}
	if (mismatches > 0) {
		throw new Error(`${mismatches} query classification(s) did not match expectation`);
	}

	// ---- Live web search (optional) ----
	console.log("\n--- Live web search ---");
	const apiKey = process.env.BRAVE_SEARCH_API_KEY;
	if (!apiKey) {
		console.log("Skipping live search(): BRAVE_SEARCH_API_KEY is not set.");
	} else {
		const results: WebSearchResult[] = await search("OpenContext memory agent GitHub", {
			apiKey,
			count: 3,
		});
		console.log(`live search returned ${results.length} result(s)`);
		for (const result of results.slice(0, 3)) {
			console.log(`- ${result.title}: ${result.url}`);
		}
		if (!Array.isArray(results)) {
			throw new Error("Expected live search() to return an array");
		}
	}

	console.log("\n[OK] Search tutorial completed");
}

export default main;

runIfMain("Search tutorial", main);
