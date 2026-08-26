/**
 * Pure-function tests for the OKF → WikiGraph adapter
 * (`packages/okf/src/graph.ts`). All tests construct messages in
 * memory and assert on the returned graph shape — no filesystem
 * or HTTP layer involved.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawMessage } from "@melandlabs/indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGraphFromDir, buildGraphFromMessages } from "./graph.js";

/** Build a minimal `RawMessage` for the adapter. */
function message(overrides: Partial<RawMessage> & Pick<RawMessage, "messageId" | "content">): RawMessage {
	return {
		messageId: overrides.messageId,
		userId: overrides.userId ?? "u-1",
		botId: overrides.botId ?? "okf-import",
		platform: overrides.platform ?? "okf",
		timestamp: overrides.timestamp ?? Date.parse("2026-08-19T10:00:00Z"),
		createdAt: overrides.createdAt ?? Date.parse("2026-08-19T10:00:00Z"),
		content: overrides.content,
		factType: overrides.factType ?? "world",
		metadata: overrides.metadata ?? { okfType: "Reference" },
	};
}

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await join(tmpdir(), `okf-graph-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

describe("buildGraphFromMessages", () => {
	it("returns one node per input message", () => {
		const graph = buildGraphFromMessages([
			message({ messageId: "a", content: "# A\n\nbody of A" }),
			message({ messageId: "b", content: "# B\n\nbody of B" }),
			message({ messageId: "c", content: "# C\n\nbody of C" }),
		]);
		expect(graph.nodes).toHaveLength(3);
		expect(graph.edges).toHaveLength(0);
		expect(graph.nodes.map((n) => n.id)).toEqual(["Reference/a", "Reference/b", "Reference/c"]);
	});

	it("uses okfType from metadata to bucket the node folder", () => {
		const graph = buildGraphFromMessages([
			message({
				messageId: "trip",
				content: "# Trip\n\nbody",
				metadata: { okfType: "Experience" },
			}),
			message({
				messageId: "belief",
				content: "# Belief\n\nbody",
				metadata: { okfType: "Opinion" },
			}),
		]);
		expect(graph.nodes.map((n) => n.type)).toEqual(["Experience", "Opinion"]);
		expect(graph.nodes.map((n) => n.id)).toEqual(["Experience/trip", "Opinion/belief"]);
	});

	it("deduplicates and resolves outgoing edges; populates backlinks", () => {
		const graph = buildGraphFromMessages([
			message({ messageId: "src", content: "# Source\n\nsee [a](a.md) and [a again](a.md)" }),
			message({ messageId: "a", content: "# A\n\nbody" }),
			message({ messageId: "b", content: "# B\n\nbody" }),
		]);
		// Dedupe collapses the two `[a](...)` references to a single edge.
		expect(graph.edges).toEqual([{ source: "Reference/src", target: "Reference/a" }]);
		const src = graph.nodes.find((n) => n.id === "Reference/src")!;
		const a = graph.nodes.find((n) => n.id === "Reference/a")!;
		expect(src.links).toEqual(["Reference/a"]);
		expect(a.backlinks).toEqual(["Reference/src"]);
	});

	it("drops self-links and links to unknown nodes", () => {
		const graph = buildGraphFromMessages([
			message({ messageId: "a", content: "# A\n\n[self](Reference/a.md) [ghost](Reference/missing.md)" }),
		]);
		expect(graph.edges).toEqual([]);
		expect(graph.nodes[0]?.links).toEqual([]);
	});

	it("resolves cross-folder links via the parent directory", () => {
		const graph = buildGraphFromMessages([
			message({
				messageId: "a",
				content: "# A\n\nsee [b](../Opinion/b.md)",
				metadata: { okfType: "Reference" },
			}),
			message({
				messageId: "b",
				content: "# B\n\nbody",
				metadata: { okfType: "Opinion" },
			}),
		]);
		expect(graph.edges).toEqual([{ source: "Reference/a", target: "Opinion/b" }]);
	});

	it("strips the leading `# title` heading from the body for `size`", () => {
		const graph = buildGraphFromMessages([
			message({ messageId: "a", content: "# Title\n\nbody content here" }),
		]);
		// `# Title\n\n` is stripped → remaining body is `body content here` (17 chars).
		expect(graph.nodes[0]?.body).toBe("body content here");
		expect(graph.nodes[0]?.size).toBe(17);
	});

	it("records `types` sorted and unique across all nodes", () => {
		const graph = buildGraphFromMessages([
			message({ messageId: "a", content: "x", metadata: { okfType: "Reference" } }),
			message({ messageId: "b", content: "x", metadata: { okfType: "Opinion" } }),
			message({ messageId: "c", content: "x", metadata: { okfType: "Reference" } }),
		]);
		expect(graph.types).toEqual(["Opinion", "Reference"]);
	});

	it("sets `root` from options.root, defaults to 'opencontext'", () => {
		const def = buildGraphFromMessages([message({ messageId: "a", content: "x" })]);
		expect(def.root).toBe("opencontext");
		const overridden = buildGraphFromMessages([message({ messageId: "a", content: "x" })], { root: "demo" });
		expect(overridden.root).toBe("demo");
	});

	it("emits a fresh `generatedAt` ISO-8601 timestamp per call", () => {
		const before = Date.now();
		const graph = buildGraphFromMessages([message({ messageId: "a", content: "x" })]);
		const ts = Date.parse(graph.generatedAt);
		expect(Number.isFinite(ts)).toBe(true);
		expect(ts).toBeGreaterThanOrEqual(before);
	});
});

describe("buildGraphFromDir", () => {
	const fixture = async (path: string, text: string) => {
		const full = join(tmpDir, path);
		await mkdir(join(tmpDir, path.replace(/[^/]+$/, "")), { recursive: true });
		await writeFile(full, text, "utf8");
	};

	it("produces a graph mirroring what `okf emit` would have written", async () => {
		await fixture(
			"Reference/acronym.md",
			`---
type: Reference
title: Project Acronym
description: OKF and its expansion
generated: { by: "demo", at: "2026-08-19T10:00:00Z" }
tags: [acronym, project]
---

OKF = Open Knowledge Format.
`,
		);
		await fixture(
			"Experience/reading.md",
			`---
type: Experience
title: Reading the OKF spec
generated: { by: "demo", at: "2026-08-19T10:00:00Z" }
---

I read the OKF spec on 2026-08-19.`,
		);
		const graph = await buildGraphFromDir(tmpDir);
		expect(graph.nodes).toHaveLength(2);
		const ids = graph.nodes.map((n) => n.id).sort();
		expect(ids).toEqual(["Experience/reading", "Reference/acronym"]);
		expect(graph.types).toEqual(["Experience", "Reference"]);
	});

	it("resolves edges between emitted files", async () => {
		await fixture(
			"Reference/a.md",
			`---
type: Reference
title: A
generated: { by: "demo", at: "2026-08-19T10:00:00Z" }
---

Links to [b](b.md).
`,
		);
		await fixture(
			"Reference/b.md",
			`---
type: Reference
title: B
generated: { by: "demo", at: "2026-08-19T10:00:00Z" }
---

Body of b.`,
		);
		const graph = await buildGraphFromDir(tmpDir);
		expect(graph.edges).toEqual([{ source: "Reference/a", target: "Reference/b" }]);
	});

	it("uses the directory basename as `root` by default", async () => {
		await fixture(
			"Reference/x.md",
			`---
type: Reference
title: X
generated: { by: "demo", at: "2026-08-19T10:00:00Z" }
---

x`,
		);
		const graph = await buildGraphFromDir(tmpDir);
		expect(graph.root).toBe(tmpDir.split("/").pop());
	});
});
