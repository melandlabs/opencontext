/**
 * @melandlabs/opencontext — facade smoke test.
 *
 * Verifies that the meta-package's published bundle resolves and that every
 * major capability surface it re-exports is callable.
 *
 * NOTE: The facade bundles several CJS npm packages (node-fetch, whatwg-url,
 * etc.) that use `require('punycode')` internally. Node 22 ESM rejects
 * those dynamic requires when the package is imported as ESM. Loaded
 * lazily so the failure is reported per-check instead of aborting the run.
 */

import { makeCheck, runSection } from "./_helpers.ts";

export default async function testOpencontext() {
	await runSection("@melandlabs/opencontext (facade)", async () => {
		const check = makeCheck("opencontext");

		let mod: Record<string, unknown> | null = null;
		try {
			mod = (await import("@melandlabs/opencontext")) as unknown as Record<string, unknown>;
		} catch (err) {
			check(
				"module loads (facade bundles CJS deps that fail under pure ESM)",
				false,
				`import failed: ${(err as Error).message}`,
			);
			return;
		}

		const get = (key: string): unknown => mod?.[key];

		check(
			"contracts.USER_TYPES is an array of length 5",
			Array.isArray(get("USER_TYPES")) && (get("USER_TYPES") as unknown[]).length === 5,
		);
		check("contracts.isUserType is a function", typeof get("isUserType") === "function");
		if (typeof get("isUserType") === "function") {
			check(
				"contracts.isUserType('pro') === true",
				(get("isUserType") as (s: string) => boolean)("pro") === true,
			);
			check(
				"contracts.isUserType('slack') === false",
				(get("isUserType") as (s: string) => boolean)("slack") === false,
			);
		}

		check("rag.chunkText is a function", typeof get("chunkText") === "function");
		if (typeof get("chunkText") === "function") {
			const chunks = (get("chunkText") as (s: string, o: { chunkSize: number }) => unknown[])(
				"OpenContext is a runtime substrate.",
				{ chunkSize: 16 },
			);
			check("rag.chunkText produces at least one chunk", chunks.length >= 1);
		}
		check("rag.SQLiteVecStore is a class", typeof get("SQLiteVecStore") === "function");
		check("rag.ChromaVectorStore is a class", typeof get("ChromaVectorStore") === "function");

		check("loop.readPreferences is a function", typeof get("readPreferences") === "function");
		check("loop.writePreferences is a function", typeof get("writePreferences") === "function");

		check("ai.getModelPricing is a function", typeof get("getModelPricing") === "function");
		check("ai.calculateTotalCredits is a function", typeof get("calculateTotalCredits") === "function");
		check("ai.estimateTokens is a function", typeof get("estimateTokens") === "function");
		if (typeof get("estimateTokens") === "function") {
			check(
				"ai.estimateTokens returns finite number",
				Number.isFinite((get("estimateTokens") as (s: string) => number)("hello world")),
			);
		}
		check("rag.generateEmbedding is a function", typeof get("generateEmbedding") === "function");

		check("memory-store.createMemoryStore is a function", typeof get("createMemoryStore") === "function");
		check(
			"unified-search.createUnifiedSearch is a function",
			typeof get("createUnifiedSearch") === "function",
		);
	});
}
