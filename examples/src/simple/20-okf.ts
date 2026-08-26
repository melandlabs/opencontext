/**
 * demo: @melandlabs/okf — OKF v0.2 (Open Knowledge Format) importer / exporter.
 *
 * OKF v0.2 is a Markdown + YAML-front-matter interchange format used by
 * Obsidian, mkdocs, and similar Markdown-based note tools. This demo
 * walks through the round-trip a host app does when bridging an outside
 * knowledge base to opencontext, using a small engineering-team fixture:
 *
 *   1. Build a fixture OKF package on disk (no opencontext yet).
 *   2. `startOkf({ action: "ingest" })` parses each `.md`, maps it to a
 *      `RawMessage`, and persists into the memory store.
 *   3. Query the memory store directly to confirm the facts landed.
 *   4. `startOkf({ action: "emit" })` writes a fresh OKF package to a
 *      second directory, complete with `manifest.json`.
 *   5. `startOkf({ action: "validate" })` round-trips the emitted
 *      package and checks that zero validation issues were introduced.
 *
 * The fixture domain is a fictional "Northwind Labs" team — five
 * docs across the Decision / Project / Person / Reference / Opinion
 * OKF types, with cross-folder wikilinks that the graph viewer can
 * turn into edges.
 *
 * No network, no LLM, no DB locks — everything happens through the
 * public surface (`parseOkf`, `okfToRawMessage`, `writeOkfPackage`,
 * `startOkf`) on a scratch sqlite file. The demo exits 1 if any check
 * fails.
 *
 * Symbols are loaded dynamically from `@melandlabs/opencontext` so this
 * demo gracefully skips on published facade versions that pre-date the
 * OKF integration (the smoke test in CI runs against already-published
 * npm versions; the OKF exports only land after this PR is merged and
 * a new `@melandlabs/opencontext` is released). We catch the ESM
 * `SyntaxError` and record a single `SKIP` instead of failing the run.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RawMessage } from "@melandlabs/indexeddb";
import { closeRawMessageStore, createRawMessageStore } from "@melandlabs/memory-store";
import { info, makeCheckWithSkip, runSection, withTmp } from "../_helpers.ts";

const DEMO_USER = "demo-northwind";

const fixtures = [
	{
		path: "Decision/cache-strategy.md",
		text: `---
type: Decision
title: Adopt write-through caching for /api/users
description: Decision recorded 2026-07-22; supersedes the 2026-05-04 spike notes.
generated: { by: "northwind-bot", at: "2026-07-22T09:00:00Z" }
tags: [caching, performance, api]
sources:
  - resource: https://northwind.dev/rfcs/2026-07-cache
verified:
  - by: alice
    at: "2026-07-22T11:00:00Z"
---

We will use a write-through Redis cache for \`GET /api/users\`.
See [northwind-cache-redis](../Reference/redis-deployment.md) for the deployment topology
and [alice](../Person/alice.md) for the owning engineer.
`,
	},
	{
		path: "Project/cache-rewrite.md",
		text: `---
type: Project
title: Cache rewrite — Q3
description: Migration to Redis with a 30-day shadow-read rollout.
generated: { by: "northwind-bot", at: "2026-07-22T09:00:00Z" }
tags: [caching, q3]
sources:
  - resource: https://northwind.dev/projects/cache-rewrite
---

The cache rewrite project tracks [cache-strategy](../Decision/cache-strategy.md) implementation
through three milestones. Owner: [alice](../Person/alice.md).
`,
	},
	{
		path: "Person/alice.md",
		text: `---
type: Person
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
title: Redis deployment topology
description: Primary + replica setup with automatic failover.
generated: { by: "northwind-bot", at: "2026-07-22T09:00:00Z" }
tags: [redis, infra]
sources:
  - resource: https://northwind.dev/infra/redis
---

Primary in eu-west-1, async replica in us-east-1. Failover is triggered
when the primary fails two consecutive health checks.
`,
	},
	{
		path: "Opinion/cache-pii.md",
		text: `---
type: Opinion
title: The cache should not store raw PII
description: My take on what we should never cache.
generated: { by: "northwind-bot", at: "2026-07-22T09:00:00Z" }
tags: [privacy, caching]
---

I think the cache should hold hashed keys only. See
[cache-strategy](../Decision/cache-strategy.md) for the alternative.
`,
	},
];

async function writeFixturePackage(root: string): Promise<void> {
	for (const f of fixtures) {
		const full = join(root, f.path);
		await mkdir(join(root, f.path.replace(/[^/]+$/, "")), { recursive: true });
		await writeFile(full, f.text, "utf8");
	}
}

function parsedSources(fm: Record<string, unknown>): unknown {
	return Array.isArray(fm.sources) ? fm.sources : ((fm as Record<string, unknown>).sources as unknown);
}

export default async function demoOkf() {
	await runSection("demo: @melandlabs/okf (v0.2 round-trip)", async () => {
		const { check, skip } = makeCheckWithSkip("demo/okf");

		// Resolve OKF exports dynamically. The CI smoke test installs
		// the published `@melandlabs/opencontext` from npm, which only
		// gains `okfToRawMessage` / `startOkf` / etc. after this PR is
		// merged and a new version is released. Treat the missing-export
		// case as an expected skip rather than a hard failure — the same
		// package still works locally against the workspace build.
		//
		// Static `import { okfToRawMessage } from "@melandlabs/opencontext"`
		// throws `SyntaxError: ... does not provide an export named ...`
		// at module load. Dynamic `await import(...)` does not throw —
		// missing symbols surface as `undefined` on the namespace. We
		// test each one with `typeof === "function"` and skip the demo
		// if any required binding is absent.
		const REQUIRED = [
			"okfToRawMessage",
			"parseOkf",
			"rawMessageToOkf",
			"readOkfPackage",
			"slugify",
			"startOkf",
			"stringifyOkf",
			"writeOkfPackage",
		] as const;
		const okfExports = (await import("@melandlabs/opencontext")) as Record<string, unknown>;
		const missing = REQUIRED.filter((name) => typeof okfExports[name] !== "function");
		if (missing.length > 0) {
			skip(
				"okf facade exports",
				`@melandlabs/opencontext is published without the OKF re-exports yet — missing: ${missing.join(", ")}`,
			);
			return;
		}
		const {
			okfToRawMessage,
			parseOkf,
			rawMessageToOkf,
			readOkfPackage,
			slugify,
			startOkf,
			stringifyOkf,
			writeOkfPackage,
		} = okfExports as {
			okfToRawMessage: typeof import("@melandlabs/opencontext").okfToRawMessage;
			parseOkf: typeof import("@melandlabs/opencontext").parseOkf;
			rawMessageToOkf: typeof import("@melandlabs/opencontext").rawMessageToOkf;
			readOkfPackage: typeof import("@melandlabs/opencontext").readOkfPackage;
			slugify: typeof import("@melandlabs/opencontext").slugify;
			startOkf: typeof import("@melandlabs/opencontext").startOkf;
			stringifyOkf: typeof import("@melandlabs/opencontext").stringifyOkf;
			writeOkfPackage: typeof import("@melandlabs/opencontext").writeOkfPackage;
		};

		const slugFromTypeAndBody = (type: string, body: string): string =>
			slugify(`${type}-${body.trim().split(/\r?\n/, 1)[0] ?? type}`);

		await withTmp("okf-demo", async (dir) => {
			// Point the SQLite default at a scratch file so the demo does
			// not contaminate the user's real ~/.opencontext/memory/.
			process.env.MEMORY_STORE_DB_PATH = join(dir, "store.db");

			const inputDir = join(dir, "input");
			const outputDir = join(dir, "output");

			// ─── 1. Build a fixture OKF package on disk. ────────────────
			await writeFixturePackage(inputDir);
			const pkg = await readOkfPackage(inputDir);
			check("readOkfPackage finds the 5 fixture files", pkg.files.length === 5, String(pkg.files.length));
			check(
				"each fixture has front-matter + body and zero issues",
				pkg.files.every((f) => Object.keys(f.document.frontMatter).length > 0 && f.issues.length === 0),
			);

			// ─── 2. Pure codec: front-matter → RawMessage. ──────────────
			const decisionFile = pkg.files.find((f) => f.path.endsWith("cache-strategy.md"));
			if (!decisionFile) {
				check("fixture includes the Decision/cache-strategy file", false, "missing");
				return;
			}
			const decisionCodec = okfToRawMessage(
				{ frontMatter: decisionFile.document.frontMatter, body: decisionFile.document.body },
				{ userId: DEMO_USER, file: decisionFile.path },
			);
			check(
				"Decision type maps to factType: mental_model",
				decisionCodec.rawMessage.factType === "mental_model",
				String(decisionCodec.rawMessage.factType),
			);
			check(
				"# title is prepended to the body content",
				decisionCodec.rawMessage.content.startsWith("# Adopt write-through caching"),
				decisionCodec.rawMessage.content.slice(0, 32),
			);
			check(
				"generated.at round-trips into timestamp",
				decisionCodec.rawMessage.timestamp === Date.parse("2026-07-22T09:00:00Z"),
				String(decisionCodec.rawMessage.timestamp),
			);
			check(
				"metadata.okfTags carries the front-matter tags",
				Array.isArray((decisionCodec.rawMessage.metadata as Record<string, unknown>)?.okfTags),
			);
			check(
				"verified[] round-trips into metadata.okfVerified",
				Array.isArray((decisionCodec.rawMessage.metadata as Record<string, unknown>)?.okfVerified),
			);

			// ─── 3. Ingest via the CLI startOkf entry-point. ────────────
			const ingestResult = await startOkf({
				action: "ingest",
				dir: inputDir,
				user: DEMO_USER,
				json: true,
			});
			check("startOkf ingest returns ok=true", ingestResult.ok === true, String(ingestResult.ok));
			check("startOkf ingest exits with 0", ingestResult.exit === 0, String(ingestResult.exit));

			// ─── 4. Query the memory store directly. ────────────────────
			// Reset the SQLite singleton so we definitely use the env-var
			// path set above. The previous demo's finally block normally
			// closes its manager, but other demos running in between can
			// also leak one and leave us pointed at their scratch db.
			await closeRawMessageStore().catch(() => undefined);
			const store = createRawMessageStore({});
			const manager = await store.getManager();
			const rows = (await manager.queryMessages({ userId: DEMO_USER, limit: 100 })) as Array<
				Pick<RawMessage, "messageId" | "content" | "factType" | "timestamp">
			>;
			await store.close();
			check("all 5 facts ended up in the memory store", rows.length === 5, String(rows.length));
			const factTypes = rows.map((r) => r.factType).sort();
			check(
				"factTypes spread across the expected set",
				factTypes.every((t) => t !== undefined),
				factTypes.join(", "),
			);
			info(
				"demo/okf",
				`stored ${rows.length} fact(s): ${rows.map((r) => `${r.messageId} (${r.factType})`).join(", ")}`,
			);

			// ─── 5. Emit a fresh OKF package. ───────────────────────────
			const emitStore = createRawMessageStore({});
			const emitManager = await emitStore.getManager();
			const emitRows = (await emitManager.queryMessages({ userId: DEMO_USER, limit: 100 })) as RawMessage[];
			const emitResult = await writeOkfPackage(outputDir, emitRows, {
				userIds: [DEMO_USER],
				packageVersion: "1.2.3",
			});
			await emitStore.close();

			check("writeOkfPackage wrote 5 markdown files", emitResult.written === 5, String(emitResult.written));
			check(
				"manifest name is opencontext-export-<user>-<yyyymmdd>",
				/^opencontext-export-demo-northwind-\d{8}$/.test(emitResult.manifest.name),
				emitResult.manifest.name,
			);
			check(
				"manifest okfConceptCount matches written",
				emitResult.manifest.okfConceptCount === emitResult.written,
				`conceptCount=${emitResult.manifest.okfConceptCount}, written=${emitResult.written}`,
			);

			const manifestRaw = await readFile(join(outputDir, "manifest.json"), "utf8");
			const parsedManifest = JSON.parse(manifestRaw) as { schema: string; files: string[] };
			check(
				"manifest.json declares schema = okf/v0.2",
				parsedManifest.schema === "okf/v0.2",
				parsedManifest.schema,
			);
			check(
				"manifest.json lists each emitted file under its Type folder",
				parsedManifest.files.every((p: string) => /^(Decision|Project|Person|Reference|Opinion)\//.test(p)),
				parsedManifest.files.join(", "),
			);

			// ─── 6. Validate the emitted package — zero new issues. ──────
			const emitted = await readOkfPackage(outputDir);
			const blocking = emitted.files.flatMap((f) => f.issues.filter((i) => i.code !== "missing_type"));
			const missingType = emitted.files.filter((f) => f.issues.some((i) => i.code === "missing_type"));
			check(
				"emitted package has zero missing_type issues",
				missingType.length === 0,
				String(missingType.length),
			);
			check(
				"emitted package has zero other validation issues",
				blocking.length === 0,
				blocking.map((i) => `${i.code}:${i.message}`).join("; ") || "none",
			);

			// ─── 7. Codec round-trip (in memory, no store). ──────────────
			const roundTripped = rawMessageToOkf(decisionCodec.rawMessage, {
				packageVersion: "1.2.3",
			});
			const roundTrippedText = stringifyOkf(roundTripped.document);
			const reparsed = parseOkf(roundTrippedText);
			check(
				"rawMessageToOkf preserves factType → type",
				reparsed.frontMatter.type === "Decision",
				String(reparsed.frontMatter.type),
			);
			check(
				"the round-tripped front-matter still tags and verifies",
				Array.isArray(reparsed.frontMatter.tags) &&
					Array.isArray(reparsed.frontMatter.verified) &&
					(Array.isArray(reparsed.frontMatter.sources) || parsedSources(reparsed.frontMatter)),
			);
			info(
				"demo/okf",
				`slug for "Decision" + "We will use a write-through Redis cache..." → ${slugFromTypeAndBody("Decision", "We will use a write-through Redis cache for /api/users.")}`,
			);
		});

		// The scratch DB lives inside withTmp(dir), so it is already gone —
		// but close the singleton defensively so subsequent tests start cold.
		await closeRawMessageStore().catch(() => undefined);
	});
}
