/**
 * @melandlabs/memory-store + @melandlabs/memory-consolidation smoke tests.
 *
 * The memory-store package exports a factory plus a handful of subpath
 * surfaces (http, mcp, raw-message-store, unified-search, etc.). We do not
 * persist to a real sqlite file here — we only verify that imports resolve,
 * the factory returns an object, and the subpath entries are accessible.
 */

import * as memoryConsolidation from "@melandlabs/memory-consolidation";
import {
	createMemoryStore,
	createUnifiedSearch,
} from "@melandlabs/memory-store";
import { makeCheck, runSection } from "./_helpers.ts";

export default async function testMemory() {
	await runSection("@melandlabs/memory-store", async () => {
		const check = makeCheck("memory-store");
		const store = await createMemoryStore();
		check("createMemoryStore returns an object", typeof store === "object");
		check("memory-store exposes .raw", typeof store.raw === "object");
		check("memory-store exposes .search", typeof store.search === "object");
		check(
			"memory-store exposes searchUnifiedMemory",
			typeof store.searchUnifiedMemory === "function",
		);

		const us = createUnifiedSearch({});
		check(
			"createUnifiedSearch returns an object with searchUnifiedMemory",
			typeof us === "object" && typeof us.searchUnifiedMemory === "function",
		);
	});

	await runSection("@melandlabs/memory-consolidation", async () => {
		const check = makeCheck("memory-consolidation");
		const names = Object.keys(memoryConsolidation).filter(
			(k) => !k.startsWith("_"),
		);
		check("module exports at least one symbol", names.length > 0);
	});
}
