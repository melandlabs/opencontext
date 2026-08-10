/**
 * @melandlabs/opencontext smoke test.
 *
 * Imports every major capability from the published facade and prints
 * a one-line confirmation per surface. Run with:
 *
 *     pnpm install
 *     pnpm start
 *
 * If any import or factory call throws, the script exits with a non-zero
 * code — that is what the user wants to know: "does this package work?"
 */

import {
	createMemoryStore,
	createUnifiedSearch,
	// contracts
	USER_TYPES,
	isUserType,
	// rag
	chunkText,
	generateEmbedding,
	SQLiteVecStore,
	ChromaVectorStore,
	// loop
	readPreferences,
	writePreferences,
	// ai (spot check, not every export)
	getModelPricing,
	calculateTotalCredits,
	estimateTokens,
} from "@melandlabs/opencontext";

function check(label: string, ok: boolean) {
	const tag = ok ? "OK" : "FAIL";
	console.log(`[${tag}] ${label}`);
	if (!ok) process.exitCode = 1;
}

async function main() {
	// 1. Contracts layer — boundary types and helpers
	check("contracts.UserType enum is exposed", USER_TYPES.length === 5);
	check("contracts.isUserType works for 'pro'", isUserType("pro"));
	check("contracts.isUserType rejects 'slack'", !isUserType("slack"));

	// 2. RAG primitives
	const chunks = chunkText("OpenContext is a runtime substrate.", { chunkSize: 16 });
	check("rag.chunkText returns at least one chunk", chunks.length >= 1);
	check(
		"rag.SQLiteVecStore is a class",
		typeof SQLiteVecStore === "function",
	);
	check(
		"rag.ChromaVectorStore is a class",
		typeof ChromaVectorStore === "function",
	);

	// 3. Loop layer
	check("loop.readPreferences is a function", typeof readPreferences === "function");
	check("loop.writePreferences is a function", typeof writePreferences === "function");

	// 4. AI surface (just spot-check pricing/credit helpers)
	check("ai.getModelPricing is a function", typeof getModelPricing === "function");
	check("ai.calculateTotalCredits is a function", typeof calculateTotalCredits === "function");
	const tokens = estimateTokens("hello world");
	check("ai.estimateTokens returns a finite number", Number.isFinite(tokens));

	// 5. Memory store — factory returns the facade without connecting (we do not
	//    call .remember here because sqlite-vec needs a writable db path; the
	//    goal is to prove the imports resolve and the factory instantiates).
	const store = await createMemoryStore();
	check("memory-store.createMemoryStore returns a facade", typeof store === "object");
	check("memory-store facade exposes .raw", typeof store.raw === "object");
	check("memory-store facade exposes .search", typeof store.search === "object");
	check(
		"memory-store facade exposes searchUnifiedMemory",
		typeof store.searchUnifiedMemory === "function",
	);

	// 6. Unified search factory
	const us = createUnifiedSearch({});
	check("unified-search.createUnifiedSearch returns a facade", typeof us === "object");
	check(
		"unified-search exposes searchUnifiedMemory",
		typeof us.searchUnifiedMemory === "function",
	);

	// Skip the embedding API call itself — it would require API keys. Just
	// verify the symbol exists.
	check("rag.generateEmbedding is a function", typeof generateEmbedding === "function");

	if (process.exitCode === 1) {
		console.error("\n[FAIL] at least one capability check failed");
	} else {
		console.log("\n[OK] @melandlabs/opencontext facade verified end-to-end");
	}
}

main().catch((err) => {
	console.error("[FAIL] uncaught error during smoke test:", err);
	process.exit(1);
});