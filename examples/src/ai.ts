/**
 * @melandlabs/ai + @melandlabs/ai-rag + @melandlabs/mcp smoke tests.
 *
 * AI helpers, RAG utilities, and MCP server scaffolding. We avoid hitting
 * live providers (no API keys) and only verify that the symbols exist and
 * the pure functions return sane shapes.
 */

import * as ai from "@melandlabs/ai";
import * as aiRag from "@melandlabs/ai-rag";
import * as mcp from "@melandlabs/mcp";
import { makeCheck, runSection } from "./_helpers.ts";

export default async function testAi() {
	await runSection("@melandlabs/ai", async () => {
		const check = makeCheck("ai");
		check(
			"getModelPricing is exported",
			typeof ai.getModelPricing === "function",
		);
		check(
			"calculateTotalCredits is exported",
			typeof ai.calculateTotalCredits === "function",
		);
		const tokens = ai.estimateTokens("OpenContext is a runtime substrate.");
		check("estimateTokens returns a finite number", Number.isFinite(tokens));
		const pricing = ai.getModelPricing("gpt-4o-mini");
		check(
			"getModelPricing returns an object (or undefined for unknown models)",
			pricing === undefined || typeof pricing === "object",
		);
	});

	await runSection("@melandlabs/ai-rag", async () => {
		const check = makeCheck("ai-rag");
		// ai-rag re-exports RAG helpers specific to the AI surface. Just verify
		// the module loads and exposes at least one symbol.
		const exportedNames = Object.keys(aiRag).filter((k) => !k.startsWith("_"));
		check("ai-rag module exports symbols", exportedNames.length > 0);
	});

	await runSection("@melandlabs/mcp", async () => {
		const check = makeCheck("mcp");
		const exportedNames = Object.keys(mcp).filter((k) => !k.startsWith("_"));
		check("mcp module exports symbols", exportedNames.length > 0);
		// Server / transport symbols are class-shaped.
		const classes = exportedNames.filter(
			(k) => typeof mcp[k as keyof typeof mcp] === "function",
		);
		check("mcp exposes at least one class/constructor", classes.length > 0);
	});
}
