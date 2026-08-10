/**
 * @melandlabs/opencontext — facade smoke test.
 *
 * Verifies that the meta-package's published bundle resolves and that every
 * major capability surface it re-exports is callable.
 */

import {
	createMemoryStore,
	createUnifiedSearch,
	USER_TYPES,
	isUserType,
	chunkText,
	generateEmbedding,
	SQLiteVecStore,
	ChromaVectorStore,
	readPreferences,
	writePreferences,
	getModelPricing,
	calculateTotalCredits,
	estimateTokens,
} from "@melandlabs/opencontext";
import { makeCheck, runSection } from "./_helpers.js";

export default async function testOpencontext() {
	await runSection("@melandlabs/opencontext (facade)", async () => {
		const check = makeCheck("opencontext");

		check("contracts.UserType has 5 members", USER_TYPES.length === 5);
		check("contracts.isUserType('pro')", isUserType("pro"));
		check("contracts.isUserType('slack') === false", !isUserType("slack"));

		const chunks = chunkText("OpenContext is a runtime substrate.", { chunkSize: 16 });
		check("rag.chunkText produces at least one chunk", chunks.length >= 1);
		check("rag.SQLiteVecStore is a class", typeof SQLiteVecStore === "function");
		check("rag.ChromaVectorStore is a class", typeof ChromaVectorStore === "function");

		check("loop.readPreferences is a function", typeof readPreferences === "function");
		check("loop.writePreferences is a function", typeof writePreferences === "function");

		check("ai.getModelPricing is a function", typeof getModelPricing === "function");
		check("ai.calculateTotalCredits is a function", typeof calculateTotalCredits === "function");
		check("ai.estimateTokens returns finite number", Number.isFinite(estimateTokens("hello world")));
		check("rag.generateEmbedding is a function", typeof generateEmbedding === "function");

		const store = await createMemoryStore();
		check("memory-store.createMemoryStore returns an object", typeof store === "object");
		check("memory-store facade exposes .raw", typeof store.raw === "object");
		check("memory-store facade exposes .search", typeof store.search === "object");
		check(
			"memory-store facade exposes searchUnifiedMemory",
			typeof store.searchUnifiedMemory === "function",
		);

		const us = createUnifiedSearch({});
		check("unified-search.createUnifiedSearch returns an object", typeof us === "object");
		check(
			"unified-search exposes searchUnifiedMemory",
			typeof us.searchUnifiedMemory === "function",
		);
	});
}
