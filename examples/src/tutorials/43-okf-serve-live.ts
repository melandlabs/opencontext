/**
 * Live mode: store messages → render the OKF graph.
 *
 * This tutorial walks through the smallest end-to-end chain that gets a
 * knowledge graph on the screen:
 *
 *   1. Five fixture `.md` documents (OKF front-matter + cross-folder
 *      wikilinks — same Northwind Labs domain as `20-okf.ts` and
 *      `21-okf-serve.ts`, so the graph has one node per OKF type).
 *   2. `parseOkf` + `okfToRawMessage` → typed `RawMessage[]`.
 *   3. `createRawMessageStore` + `manager.storeMessages` → SQLite.
 *   4. `startOkfServe({ rawStore })` → Hono HTTP viewer (random port).
 *   5. `fetch /api/graph` → the `WikiGraph` consumed by the viewer.
 *   6. Pretty-print the graph so you can see the cross-folder edges
 *      between `Decision`, `Project`, `Person`, `Reference`, `Opinion`.
 *
 * The viewer itself is `packages/okf/src/viewer/` — open
 * `http://127.0.0.1:<port>/viewer/` in a browser once the script
 * prints the URL to see it render the same graph with a force-directed
 * canvas.
 *
 * No network, no LLM. The SQLite file is created in a scratch
 * directory and deleted on exit.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { runIfMain } from "../_helpers.ts";

const DEMO_USER = "demo-okf-serve-live";

/**
 * When `OKF_KEEP_OPEN=1` is set in the environment, the tutorial keeps
 * the viewer alive after printing the graph so the reader can open
 * `http://127.0.0.1:<port>/viewer/` in a browser and inspect the live
 * force-directed canvas. Press Ctrl-C (or send SIGINT) to tear down.
 */
const KEEP_OPEN = process.env.OKF_KEEP_OPEN === "1";

/** Resolve on the next SIGINT so the tutorial can block until the user
 * is done exploring the viewer. `process.once` registers the listener
 * once; the second signal (after we exit) goes to Node's default handler. */
function waitForSigint(): Promise<void> {
	if (typeof process === "undefined") return Promise.resolve();
	return new Promise((resolve) => {
		process.once("SIGINT", () => resolve());
	});
}

/**
 * Five fixture documents share the "Northwind Labs" engineering-team
 * domain used by `examples/src/simple/20-okf.ts` and
 * `examples/src/simple/21-okf-serve.ts`. Every fixture carries an OKF
 * front-matter and bodies that cross-link each other with
 * `[label](../Type/slug.md)` syntax; the resulting graph has one node
 * per type, with `Decision ↔ Reference`, `Project → Decision`,
 * `Person → Project`, and `Opinion → Decision` edges — enough topology
 * for the screenshot to show three distinct clusters.
 */
const FIXTURES = [
	{
		path: "Decision/cache-strategy.md",
		text: `---
type: Decision
resource: cache-strategy
title: Adopt write-through caching for /api/users
description: Decision recorded 2026-07-22; supersedes the 2026-05-04 spike notes.
generated: { by: "northwind-bot", at: "2026-07-22T09:00:00Z" }
tags: [caching, performance, api]
---

We will use a write-through Redis cache for \`GET /api/users\`.
See [redis-deployment](../Reference/redis-deployment.md) for the topology
and [alice](../Person/alice.md) for the owning engineer.
`,
	},
	{
		path: "Project/cache-rewrite.md",
		text: `---
type: Project
resource: cache-rewrite
title: Cache rewrite — Q3
description: Migration to Redis with a 30-day shadow-read rollout.
generated: { by: "northwind-bot", at: "2026-07-22T09:00:00Z" }
tags: [caching, q3]
---

The cache rewrite project tracks [cache-strategy](../Decision/cache-strategy.md)
implementation through three milestones. Owner: [alice](../Person/alice.md).
`,
	},
	{
		path: "Person/alice.md",
		text: `---
type: Person
resource: alice
title: Alice Tan
description: Staff engineer on the Platform team; owns the cache rewrite project.
generated: { by: "northwind-bot", at: "2026-07-22T09:00:00Z" }
tags: [platform, staff]
---

Alice owns [cache-rewrite](../Project/cache-rewrite.md) and authored
the [cache-strategy](../Decision/cache-strategy.md) decision.
`,
	},
	{
		path: "Reference/redis-deployment.md",
		text: `---
type: Reference
resource: redis-deployment
title: Redis deployment topology
description: Primary + replica setup with automatic failover.
generated: { by: "northwind-bot", at: "2026-07-22T09:00:00Z" }
tags: [redis, infra]
---

Primary in eu-west-1, async replica in us-east-1.
Failover triggers after two consecutive failed health checks.
`,
	},
	{
		path: "Opinion/cache-pii.md",
		text: `---
type: Opinion
resource: cache-pii
title: The cache should not store raw PII
description: My take on what we should never cache.
generated: { by: "northwind-bot", at: "2026-07-22T09:00:00Z" }
tags: [privacy, caching]
---

I think the cache should hold hashed keys only.
See [cache-strategy](../Decision/cache-strategy.md) for the alternative.
`,
	},
] as const;

async function main() {
	// Resolve every OKF / memory-store symbol from the facade so this
	// tutorial survives facade renames (matches the dynamic-import
	// skip pattern used in `examples/src/simple/21-okf-serve.ts`).
	const facade = (await import("@melandlabs/opencontext")) as Record<string, unknown>;
	const required = [
		"okfToRawMessage",
		"parseOkf",
		"startOkfServe",
		"createRawMessageStore",
		"closeRawMessageStore",
	] as const;
	const missing = required.filter((name) => typeof facade[name] !== "function");
	if (missing.length > 0) {
		console.log(`[SKIP] 43-okf-serve-live: facade missing exports — ${missing.join(", ")}`);
		return;
	}

	const { okfToRawMessage, parseOkf, startOkfServe, createRawMessageStore, closeRawMessageStore } =
		facade as {
			okfToRawMessage: typeof import("@melandlabs/opencontext").okfToRawMessage;
			parseOkf: typeof import("@melandlabs/opencontext").parseOkf;
			startOkfServe: typeof import("@melandlabs/opencontext").startOkfServe;
			createRawMessageStore: typeof import("@melandlabs/opencontext").createRawMessageStore;
			closeRawMessageStore: typeof import("@melandlabs/opencontext").closeRawMessageStore;
		};

	// ── 1. Scratch store so we never touch ~/.opencontext/memory/. ─────
	const scratchDir = `/tmp/okf-serve-live-${Date.now()}`;
	const dbPath = join(scratchDir, "memory.db");
	process.env.MEMORY_STORE_DB_PATH = dbPath;
	console.log(`[STEP 1] scratch store at ${dbPath}`);

	// ── 2. Convert fixtures to RawMessages. ──
	const rawMessages = FIXTURES.map((f) => {
		const parsed = parseOkf(f.text);
		const codec = okfToRawMessage(parsed, { userId: DEMO_USER, file: f.path });
		return codec.rawMessage;
	});
	console.log(`[STEP 2] parsed ${rawMessages.length} OKF docs → RawMessages`);
	console.log(`         types: ${rawMessages.map((m) => m.factType).join(", ")}`);

	// ── 3. Insert into SQLite via the real manager surface. ──
	const store = createRawMessageStore({});
	const manager = await store.getManager();
	const ids = await manager.storeMessages(rawMessages);
	await store.close();
	console.log(`[STEP 3] stored ${ids.length} rows (last id #${ids.at(-1)})`);
	await closeRawMessageStore().catch(() => undefined);

	// ── 4. Boot the OKF viewer in live mode on a random port. ──
	const port = 30_000 + Math.floor(Math.random() * 10_000);
	const liveStore = createRawMessageStore({});
	const server = await startOkfServe({
		port,
		user: DEMO_USER,
		rawStore: liveStore,
	});
	console.log(`[STEP 4] OKF viewer listening at ${server.url}/`);
	console.log(`         graph: ${server.url}/api/graph`);
	console.log(`         page : ${server.url}/viewer/`);

	// ── 5. Fetch /health and /api/graph. ──
	try {
		const health = await fetch(`${server.url}/health`).then((r) => r.json());
		console.log(`[STEP 5] /health → ${JSON.stringify(health)}`);

		const graph = (await fetch(`${server.url}/api/graph`).then((r) => r.json())) as {
			root: string;
			generatedAt: string;
			types: string[];
			nodes: Array<{
				id: string;
				title: string;
				type: string;
				tags: string[];
				size: number;
				links: string[];
			}>;
			edges: Array<{ source: string; target: string }>;
		};

		console.log(`[STEP 6] /api/graph`);
		console.log(`         root       : ${graph.root}`);
		console.log(`         generatedAt: ${graph.generatedAt}`);
		console.log(`         types      : [${graph.types.join(", ")}]`);
		console.log(`         nodes      : ${graph.nodes.length}`);
		console.log(`         edges      : ${graph.edges.length}`);
		console.log("");
		console.log("         nodes:");
		for (const n of graph.nodes) {
			console.log(
				`           • ${n.id.padEnd(28)} type=${n.type.padEnd(10)} size=${n.size.toString().padStart(4)} tags=[${n.tags.join(",")}]`,
			);
		}
		console.log("");
		console.log("         edges:");
		for (const e of graph.edges) {
			console.log(`           ${e.source} → ${e.target}`);
		}

		if (KEEP_OPEN) {
			console.log("");
			console.log(`[KEEP-OPEN] viewer stays up at ${server.url}/viewer/`);
			console.log(`            graph endpoint: ${server.url}/api/graph`);
			console.log(`            Press Ctrl-C (or send SIGINT) to stop.`);
			await waitForSigint();
		}
	} finally {
		await server.stop();
		await rm(scratchDir, { recursive: true, force: true });
		console.log(`[DONE]   server stopped, scratch dir removed`);
	}
}

export default main;
runIfMain("43-okf-serve-live", main, import.meta.url);
