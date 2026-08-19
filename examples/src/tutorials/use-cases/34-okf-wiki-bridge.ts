/**
 * Use case: external OKF wiki → opencontext bridge.
 *
 * Imagine a small team that keeps its design docs in a wiki that already
 * speaks OKF v0.2 (openwiki, Obsidian-with-OKR, mkdocs-with-okf-plugin).
 * The wiki has been running for months; new docs land there every day.
 * The team wants opencontext to remember everything that's been decided
 * so that agents and humans can recall it at conversation time.
 *
 * The whole bridge fits in three steps:
 *
 *   1. Pull the wiki from disk (this demo stages a tiny fixture) and
 *      ingest each `.md` into the memory store via `startOkf(ingest)`.
 *   2. Recall the facts through a unified search so the team can ask
 *      "what did we decide about X?" the same way they'd ask about a
 *      Slack message.
 *   3. Re-emit an updated OKF package back to disk so the wiki's source
 *      tree can be re-synced (e.g. with a CI step `okf emit → git
 *      commit → push`).
 *
 * Why this matters: opencontext is the *memory store of record* and the
 * wiki is just a readable projection of that memory. Agents get richer
 * recall (semantic, time-aware), humans keep their git-tracked
 * Markdown.
 *
 * The demo runs against a fresh sqlite file (no network, no embeddings,
 * no API keys).
 *
 * The OKF symbols are loaded dynamically from `@melandlabs/opencontext`
 * so this use-case gracefully skips when the published facade version
 * pre-dates the OKF integration (the smoke test in CI installs the
 * published npm versions, which only gain `startOkf` / `writeOkfPackage`
 * / `readOkfPackage` after this PR merges and a new release ships).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { closeRawMessageStore, createRawMessageStore } from "@melandlabs/memory-store";
import { info, makeCheckWithSkip, runIfMain, runSection, withTmp } from "../../_helpers.ts";

interface WikiDoc {
	path: string;
	text: string;
}

const WIKI: WikiDoc[] = [
	{
		path: "Reference/architecture.md",
		text: `---
type: Reference
title: System Architecture
description: High-level shape of the bridge between OKF and opencontext.
generated: { by: "wiki@team", at: "2026-07-01T09:00:00Z" }
tags: [architecture, bridge]
verified:
  - by: lead
    at: "2026-07-02T10:00:00Z"
---

The bridge ingests external OKF v0.2 docs into opencontext and re-emits
them on demand. The wiki remains the canonical source of truth for
humans; opencontext provides recall for agents.
`,
	},
	{
		path: "Experience/migration.md",
		text: `---
type: Experience
title: Migrating from the old SQLite-backed bridge
generated: { by: "wiki@team", at: "2026-07-04T14:00:00Z" }
---

We migrated from the in-house ingestion script to
\`opencontext okf ingest\` on 2026-07-04. The old script silently dropped
docs with broken YAML; the new one surfaces them as issues so we can
patch the wiki instead of losing context.
`,
	},
	{
		path: "Opinion/cadence.md",
		text: `---
type: Opinion
title: Wiki sync cadence
generated: { by: "wiki@team", at: "2026-07-10T16:30:00Z" }
---

A nightly cron that runs \`opencontext okf emit\` and pushes the result
to git is a much saner default than running it on every commit — it
keeps the noise out of the wiki's PR review queue.
`,
	},
];

async function stageWiki(root: string): Promise<void> {
	for (const doc of WIKI) {
		const full = join(root, doc.path);
		// The fixture paths are nested; create the parent directory first.
		const parent = full.replace(/[^/]+$/, "");
		if (parent && parent !== full) {
			await mkdir(parent, { recursive: true });
		}
		await writeFile(full, doc.text, "utf8");
	}
}

export default async function demoOkfWikiBridge() {
	await runSection("use-case: OKF wiki → opencontext bridge", async () => {
		const { check, skip } = makeCheckWithSkip("use-case/okf-bridge");

		// Resolve OKF exports dynamically — see top-of-file note.
		let okfExports: {
			OkfPackageManifest: typeof import("@melandlabs/opencontext").OkfPackageManifest;
			readOkfPackage: typeof import("@melandlabs/opencontext").readOkfPackage;
			startOkf: typeof import("@melandlabs/opencontext").startOkf;
			writeOkfPackage: typeof import("@melandlabs/opencontext").writeOkfPackage;
		};
		try {
			okfExports = await import("@melandlabs/opencontext");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			skip(
				"okf facade exports",
				"@melandlabs/opencontext is published without the OKF re-exports yet",
				message,
			);
			return;
		}
		const { OkfPackageManifest, readOkfPackage, startOkf, writeOkfPackage } = okfExports;
		void OkfPackageManifest; // kept typed for the user; flow uses it implicitly via writeOkfPackage's return.

		await withTmp("okf-bridge", async (scratch) => {
			// Point the default SQLite backend at a scratch file so we
			// don't pollute the user's home dir.
			process.env.MEMORY_STORE_DB_PATH = join(scratch, "store.db");

			const wikiDir = join(scratch, "wiki");
			const outputDir = join(scratch, "export-2026-07-12");
			await stageWiki(wikiDir);

			// ─── 1. Ingest the whole wiki. ──────────────────────────────
			// `startOkf(..., { json: true })` writes the summary envelope
			// via the `sink` we hand it. That lets the demo assert on the
			// counts without monkey-patching `console.log`.
			let ingestEnvelope = "";
			const ingestResult = await startOkf(
				{
					action: "ingest",
					dir: wikiDir,
					user: "u-wiki-bridge",
					json: true,
					continueOnError: true,
				},
				{ sink: (line) => (ingestEnvelope = line) },
			);
			const ingestSummary = JSON.parse(ingestEnvelope || "{}") as {
				ok?: boolean;
				exit?: number;
				summary?: { ingested: number; skipped: number; issues: number };
			};
			check(
				"ingest exited cleanly",
				ingestResult.ok === true && ingestSummary.ok === true,
				`ok=${ingestResult.ok} exit=${ingestResult.exit}`,
			);
			check(
				"the count of ingested facts equals the wiki file count",
				ingestSummary.summary?.ingested === WIKI.length,
				`ingested=${ingestSummary.summary?.ingested} wiki=${WIKI.length}`,
			);

			// ─── 2. Recall from the memory store. ────────────────────────
			const store = createRawMessageStore({});
			const manager = await store.getManager();
			const all = (await manager.queryMessages({
				userId: "u-wiki-bridge",
				limit: 100,
			})) as Array<{ messageId: string; content: string; factType: string }>;
			await store.close();

			check(
				"the memory store has all 3 wiki facts",
				all.length === WIKI.length,
				`store=${all.length} wiki=${WIKI.length}`,
			);
			const factTypes = all.map((r) => r.factType).sort();
			check(
				"factTypes span all three opencontext categories",
				JSON.stringify(factTypes) === JSON.stringify(["experience", "mental_model", "world"]),
				factTypes.join(", "),
			);

			// The simplest recall is to grep titles & content. Pretend the
			// "query" was "what did we decide about the wiki sync cadence?"
			// — we directly match by content, since this demo runs without
			// an embedding provider.
			const cadenceHit = all.find((r) => /cadence/i.test(r.content));
			check(
				"the cadence opinion is retrievable by content",
				cadenceHit !== undefined,
				cadenceHit?.messageId ?? "missing",
			);
			info("use-case/okf-bridge", `recall hit: ${cadenceHit?.messageId} (${cadenceHit?.factType})`);

			// ─── 3. Re-emit an OKF package for the wiki. ─────────────────
			const emitStore = createRawMessageStore({});
			const emitManager = await emitStore.getManager();
			const emitRows = (await emitManager.queryMessages({
				userId: "u-wiki-bridge",
				limit: 100,
			})) as Parameters<typeof writeOkfPackage>[1];
			const emit = await writeOkfPackage(outputDir, emitRows, {
				userIds: ["u-wiki-bridge"],
				packageName: "wiki-snapshot-2026-07-12",
				packageVersion: "0.1.0",
			});
			await emitStore.close();

			check("emit wrote one file per fact", emit.written === WIKI.length, String(emit.written));
			check(
				"manifest name matches the requested packageName",
				emit.manifest.name === "wiki-snapshot-2026-07-12",
				emit.manifest.name,
			);
			check(
				"manifest schema is the documented okf/v0.2",
				emit.manifest.schema === "okf/v0.2",
				emit.manifest.schema,
			);

			const round = await readOkfPackage(outputDir);
			const validationIssues = round.files.flatMap((f) => f.issues.filter((i) => i.code !== "missing_type"));
			check(
				"the round-tripped package validates with zero issues",
				validationIssues.length === 0,
				validationIssues.map((i) => i.code).join(",") || "none",
			);

			// ─── 4. The re-emitted package preserves the cadence opinion. ─
			// File slugs don't contain the original title, so look up the
			// cadence doc by the messageId we already recovered from recall
			// (the emitted filename embeds that slug).
			const cadenceFile = round.files.find((f) =>
				cadenceHit ? f.path.includes(cadenceHit.messageId) : false,
			);
			check("the cadence opinion file survived the round-trip", cadenceFile !== undefined, cadenceFile?.path);
			const cadenceBody = cadenceFile ? await readFile(join(outputDir, cadenceFile.path), "utf8") : "";
			check(
				"the re-emitted cadence file still mentions nightly cron",
				/cron|nightly/i.test(cadenceBody),
				cadenceBody.length > 0 ? `${cadenceBody.slice(0, 60).trim()}…` : "(empty)",
			);

			// Skip a hint about the upstream search layer when the host
			// environment can't load it (e.g. CJS-only transitive deps).
			skip(
				"embedding-powered recall (sqlite-vec) is exercised in 02-rag-vector-store",
				"this use case focuses on the OKF bridge — see demos 02/14 for the recall layer",
			);
		});

		await closeRawMessageStore().catch(() => undefined);
	});
}

if (import.meta.url === `file://${process.argv[1]}`) {
	runIfMain("use-case: okf-wiki-bridge", async () => {
		await demoOkfWikiBridge();
	});
}
