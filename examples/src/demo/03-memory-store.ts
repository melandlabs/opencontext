/**
 * demo: @melandlabs/memory-store — unified memory search.
 *
 * `createMemoryStore()` builds the memory facade an agent queries at
 * recall time. It fans a single query out across three sources —
 * raw messages ("memory"), derived "insights", and the "knowledge" base —
 * and merges them into one ranked result list.
 *
 * Backend selection: local SQLite is the unconditional default. The
 * demo points `MEMORY_STORE_DB_PATH` at a scratch file so it really
 * opens and writes a sqlite database (and doesn't touch the user's
 * `~/.opencontext/memory/store.db`), then cleans up afterwards.
 *
 * To opt into a host-registered Postgres factory instead, set
 * `OPENCONTEXT_MEMORY_STORE_BACKEND=postgres` and call
 * `registerPostgresFactory()` at startup.
 *
 * The important design property demonstrated here: sources that aren't
 * configured in the current environment degrade into structured
 * `warnings` instead of throwing. An agent asking for context always
 * gets an answer, plus a machine-readable note about what was missing.
 */

import { createMemoryStore, createUnifiedSearch } from "@melandlabs/memory-store";
import { info, makeCheck, runSection, withTmp } from "../_helpers.ts";

export default async function demoMemoryStore() {
	await runSection("demo: @melandlabs/memory-store", async () => {
		const check = makeCheck("demo/memory");

		await withTmp("memory-store", async (dir) => {
			// Point the default SQLite backend at a scratch file so the demo
			// never touches the user's home dir.
			process.env.MEMORY_STORE_DB_PATH = `${dir}/store.db`;

			const store = await createMemoryStore();

			// Which persistence backend did the store pick, and is it usable here?
			const backend = store.raw.getBackend();
			const available = store.raw.isAvailable();
			info("demo/memory", `raw message backend = ${backend}, available = ${available}`);
			check("the store picks sqlite as the unconditional default", backend === "sqlite", backend);
			check("sqlite backend reports itself available", available === true, String(available));

			// The actual recall call an agent makes.
			const res = await store.searchUnifiedMemory({
				userId: "demo-user",
				query: "what did we decide about the retrieval pipeline?",
				limit: 5,
			});

			info("demo/memory", `fanned out to: ${res.sources.join(", ")}`);
			info("demo/memory", `count=${res.count}`);
			for (const w of res.warnings) {
				info("demo/memory", `  warning [${w.source}] ${w.code}: ${w.message}`);
			}

			check(
				"the response echoes the query",
				res.query === "what did we decide about the retrieval pipeline?",
			);
			check(
				"all three sources were consulted",
				(["memory", "insights", "knowledge"] as const).every((s) => res.sources.includes(s)),
				res.sources.join(", "),
			);
			check(
				"results is an array whose length matches count",
				Array.isArray(res.results) && res.results.length === res.count,
				`${res.count} results`,
			);
			check(
				"unconfigured sources degrade to structured warnings instead of throwing",
				res.warnings.every(
					(w) => typeof w.source === "string" && typeof w.code === "string" && typeof w.message === "string",
				),
				res.warnings.map((w) => w.code).join(", ") || "none",
			);

			// `createUnifiedSearch` is the same search surface without the
			// rest of the store — handy when you only need recall.
			const search = createUnifiedSearch({});
			const direct = await search.searchUnifiedMemory({ userId: "demo-user", query: "ping", limit: 1 });
			info("demo/memory", `createUnifiedSearch standalone returned count=${direct.count}`);
			check("createUnifiedSearch exposes the same searchUnifiedMemory contract", direct.query === "ping");
			check("its results are an array too", Array.isArray(direct.results));
		});
	});
}
