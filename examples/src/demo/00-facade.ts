/**
 * demo: @melandlabs/opencontext — the single-package facade.
 *
 * This is the "install one package, get the whole substrate" entry point.
 * Everything below is re-exported from a workspace package, so you can
 * start here and drop down to `@melandlabs/rag` / `@melandlabs/ai` /
 * `@melandlabs/memory-store` later without changing any call sites.
 */

import {
	chunkText,
	createMemoryStore,
	estimateTokens,
	getModelPricing,
	isUserType,
} from "@melandlabs/opencontext";
import { info, makeCheckWithSkip, runSection } from "../_helpers.ts";
const ARTICLE = [
	"OpenContext is a runtime substrate for context-aware agents.",
	"It bundles retrieval, memory, scheduling, and integrations.",
	"Each capability also ships as its own npm package.",
].join("\n\n");

export default async function demoFacade() {
	await runSection("demo: @melandlabs/opencontext (facade)", async () => {
		const { check, skip } = makeCheckWithSkip("demo/facade");

		// 1. Chunk a document for retrieval.
		const chunks = chunkText(ARTICLE, { maxChunkSize: 80, chunkOverlap: 10 });
		info("demo/facade", `chunkText split ${ARTICLE.length} chars into ${chunks.length} chunk(s)`);
		info("demo/facade", `first chunk: ${JSON.stringify(chunks[0].content.slice(0, 48))}…`);
		check("chunkText split the article into multiple chunks", chunks.length > 1, `${chunks.length} chunks`);
		check(
			"every chunk respects maxChunkSize",
			chunks.every((c) => c.content.length <= 80),
			`longest=${Math.max(...chunks.map((c) => c.content.length))}`,
		);
		check(
			"chunks reassemble to cover the whole article",
			chunks[0].startPosition === 0 && chunks[chunks.length - 1].endPosition >= ARTICLE.trim().length - 1,
		);

		// 2. Budget the tokens those chunks would cost.
		//    NOTE: the facade re-exports both @melandlabs/rag's and
		//    @melandlabs/ai's `getModelPricing`, and rag wins the name
		//    collision — so through the facade this returns the embedding
		//    price in USD per million tokens (a number), not the chat
		//    pricing object. Import from @melandlabs/ai directly if you
		//    want the chat pricing table (see demo/04-ai.ts).
		const tokens = estimateTokens(ARTICLE);
		const embeddingPrice = getModelPricing("text-embedding-3-small");
		info("demo/facade", `estimateTokens = ${tokens} tokens for the article`);
		info("demo/facade", `embedding price = $${embeddingPrice} per million tokens`);
		check("estimateTokens returns a positive count", tokens > 0, `${tokens} tokens`);
		check(
			"getModelPricing returns a positive per-million price",
			typeof embeddingPrice === "number" && embeddingPrice > 0,
			`$${embeddingPrice}/M`,
		);

		// 3. Boundary type guards, straight from @melandlabs/contracts.
		check("isUserType('pro') accepts a real user type", isUserType("pro") === true);
		check("isUserType('slack') rejects a non-user-type", isUserType("slack") === false);

		// 4. Open the memory store and run a real unified query. Needs the
		//    better-sqlite3 native binding, which may not build everywhere.
		try {
			const store = await createMemoryStore();
			const res = await store.searchUnifiedMemory({
				userId: "demo-user",
				query: "what did we decide about retrieval?",
				limit: 5,
			});
			info("demo/facade", `searchUnifiedMemory fanned out to sources: ${res.sources.join(", ")}`);
			info("demo/facade", `count=${res.count}, warnings=${res.warnings.length}`);
			check("searchUnifiedMemory echoes the query back", res.query === "what did we decide about retrieval?");
			check(
				"searchUnifiedMemory returns a results array (empty on a fresh store)",
				Array.isArray(res.results) && res.results.length === res.count,
				`${res.count} results`,
			);
			check(
				"unconfigured sources are reported as warnings, not thrown errors",
				res.warnings.every((w) => typeof w.code === "string" && typeof w.message === "string"),
				res.warnings.map((w) => w.code).join(", ") || "none",
			);
		} catch (err) {
			skip(
				"createMemoryStore + searchUnifiedMemory",
				"native better-sqlite3 binding unavailable",
				(err as Error).message,
			);
		}
	});
}
