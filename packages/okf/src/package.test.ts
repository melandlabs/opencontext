import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RawMessage } from "@melandlabs/indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOkfPackage, writeOkfPackage } from "./package.js";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "okf-test-"));
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

const sampleMessage: RawMessage = {
	messageId: "reference-foo",
	userId: "u-1",
	botId: "okf-import",
	platform: "okf",
	timestamp: Date.parse("2026-08-19T10:00:00Z"),
	content: "OKF = Open Knowledge Format.",
	factType: "world",
	createdAt: Date.parse("2026-08-19T10:00:00Z"),
	metadata: {
		okfGenerator: "test",
		okfTags: ["acronym", "okf"],
	},
};

const sampleExperience: RawMessage = {
	...sampleMessage,
	messageId: "experience-bar",
	factType: "experience",
	content: "I read the OKF spec on 2026-08-19.",
	metadata: {
		okfType: "Episode",
		okfGenerator: "test",
	},
};

const sampleOpinion: RawMessage = {
	...sampleMessage,
	messageId: "opinion-baz",
	factType: "mental_model",
	content: "OKF is well-designed.",
	metadata: {
		okfType: "Opinion",
		okfGenerator: "test",
	},
};

describe("readOkfPackage", () => {
	it("returns an empty result for a directory with no .md files", async () => {
		const result = await readOkfPackage(tmpDir);
		expect(result.files).toEqual([]);
		expect(result.manifest).toBeUndefined();
	});

	it("parses .md files and validates front-matter", async () => {
		await writeFile(
			join(tmpDir, "foo.md"),
			"---\ntype: Reference\ngenerated: { by: test, at: '2026-08-19T10:00:00Z' }\n---\nbody\n",
		);
		const result = await readOkfPackage(tmpDir);
		expect(result.files.length).toBe(1);
		expect(result.files[0]?.document.frontMatter.type).toBe("Reference");
		expect(result.files[0]?.issues).toEqual([]);
	});

	it("collects missing_type issues without throwing", async () => {
		await writeFile(join(tmpDir, "missing.md"), "---\ntitle: no-type\n---\nbody\n");
		const result = await readOkfPackage(tmpDir);
		expect(result.files[0]?.issues.some((i) => i.code === "missing_type")).toBe(true);
	});

	it("tolerates a missing manifest.json", async () => {
		await writeFile(
			join(tmpDir, "foo.md"),
			"---\ntype: Reference\ngenerated: { by: test, at: '2026-08-19T10:00:00Z' }\n---\nbody\n",
		);
		const result = await readOkfPackage(tmpDir);
		expect(result.manifest).toBeUndefined();
		expect(result.files.length).toBe(1);
	});

	it("parses a manifest.json when present", async () => {
		const manifest = {
			schema: "okf/v0.2",
			name: "test-pkg",
			generatedAt: "2026-08-19T10:00:00Z",
			generatedBy: "test",
			okfConceptCount: 1,
			okfTypeCounts: { Reference: 1 },
			sources: ["memory-store"],
			userIds: ["u-1"],
			platforms: ["okf"],
			files: ["Reference/foo.md"],
		};
		await writeFile(join(tmpDir, "manifest.json"), JSON.stringify(manifest));
		const relPath = "Reference/foo.md";
		const fullPath = join(tmpDir, relPath);
		await mkdir(dirname(fullPath), { recursive: true });
		await writeFile(
			fullPath,
			"---\ntype: Reference\ngenerated: { by: test, at: '2026-08-19T10:00:00Z' }\n---\nbody\n",
		);
		const result = await readOkfPackage(tmpDir);
		expect(result.manifest?.name).toBe("test-pkg");
	});

	it("recurses into nested directories", async () => {
		const refPath = join(tmpDir, "Reference/foo.md");
		await mkdir(dirname(refPath), { recursive: true });
		await writeFile(
			refPath,
			"---\ntype: Reference\ngenerated: { by: test, at: '2026-08-19T10:00:00Z' }\n---\nbody\n",
		);
		const opPath = join(tmpDir, "Opinion/bar.md");
		await mkdir(dirname(opPath), { recursive: true });
		await writeFile(
			opPath,
			"---\ntype: Opinion\ngenerated: { by: test, at: '2026-08-19T10:00:00Z' }\n---\nbody\n",
		);
		const result = await readOkfPackage(tmpDir);
		expect(result.files.length).toBe(2);
	});

	it("ignores non-`.md` files", async () => {
		await writeFile(join(tmpDir, "blob.bin"), "not a markdown file");
		await writeFile(
			join(tmpDir, "foo.md"),
			"---\ntype: Reference\ngenerated: { by: test, at: '2026-08-19T10:00:00Z' }\n---\nbody\n",
		);
		const result = await readOkfPackage(tmpDir);
		expect(result.files.length).toBe(1);
	});
});

describe("writeOkfPackage", () => {
	it("writes a manifest.json plus per-Type markdown files", async () => {
		const result = await writeOkfPackage(tmpDir, [sampleMessage, sampleExperience, sampleOpinion], {
			packageVersion: "1.2.3",
		});
		expect(result.written).toBe(3);
		const manifest = JSON.parse(await readFile(join(tmpDir, "manifest.json"), "utf8"));
		expect(manifest.schema).toBe("okf/v0.2");
		expect(manifest.name).toMatch(/^opencontext-export-u-1-\d{8}$/);
		expect(manifest.okfConceptCount).toBe(3);
		expect(manifest.generatedBy).toBe("opencontext@1.2.3");
		expect(manifest.okfTypeCounts).toEqual({
			// sampleMessage → Reference, sampleExperience's okfType=Episode
			// wins, sampleOpinion's okfType=Opinion wins.
			Reference: 1,
			Episode: 1,
			Opinion: 1,
		});
		// Layout
		const ref = await readFile(join(tmpDir, "Reference/reference-foo.md"), "utf8");
		expect(ref).toContain("type: Reference");
		expect(ref).toContain("OKF = Open Knowledge Format.");
	});

	it("dedupes slugs with -2 / -3 suffix", async () => {
		const a = { ...sampleMessage, messageId: "reference-foo" };
		const b = { ...sampleMessage, messageId: "reference-foo-2" };
		const result = await writeOkfPackage(tmpDir, [a, b]);
		expect(result.written).toBe(2);
		// Path list should expose both
		expect(result.paths.sort()).toEqual(["Reference/reference-foo-2.md", "Reference/reference-foo.md"]);
	});

	it("keeps the original casing of a valid type folder", async () => {
		const result = await writeOkfPackage(tmpDir, [sampleExperience]);
		expect(result.paths).toEqual(["Episode/experience-bar.md"]);
	});

	it("sanitises a traversal-prone okfType into a folder under root", async () => {
		const evil: RawMessage = {
			...sampleMessage,
			messageId: "evil-1",
			metadata: { okfType: "../../../tmp/evil", okfGenerator: "test" },
		};
		const result = await writeOkfPackage(tmpDir, [evil]);
		expect(result.written).toBe(1);
		// No emitted path may escape `root` via `..` segments.
		expect(result.paths.every((p) => !p.startsWith(".."))).toBe(true);
		// The file lands inside root under the sanitised folder name.
		const text = await readFile(join(tmpDir, "evil", "evil-1.md"), "utf8");
		expect(text).toContain("type: ../../../tmp/evil");
	});

	it("skips archived messages when includeArchived is false", async () => {
		const archived = { ...sampleMessage, archivedAt: Date.now() };
		const result = await writeOkfPackage(tmpDir, [sampleMessage, archived]);
		expect(result.written).toBe(1);
	});

	it("includes archived messages when includeArchived is true", async () => {
		const archived = { ...sampleMessage, archivedAt: Date.now() };
		const result = await writeOkfPackage(tmpDir, [sampleMessage, archived], { includeArchived: true });
		expect(result.written).toBe(2);
	});

	it("respects userIds / platforms override", async () => {
		await writeOkfPackage(tmpDir, [sampleMessage], {
			userIds: ["u-x", "u-y"],
			platforms: ["chrome"],
		});
		const manifest = JSON.parse(await readFile(join(tmpDir, "manifest.json"), "utf8"));
		expect(manifest.userIds).toContain("u-x");
		expect(manifest.userIds).toContain("u-y");
		expect(manifest.platforms).toContain("chrome");
	});

	it("round-trips: write → read → same file set", async () => {
		await writeOkfPackage(tmpDir, [sampleMessage, sampleExperience, sampleOpinion], {
			packageVersion: "1.2.3",
		});
		const back = await readOkfPackage(tmpDir);
		expect(back.files.length).toBe(3);
		const types = back.files.map((f) => f.document.frontMatter.type).sort();
		expect(types).toEqual(["Episode", "Opinion", "Reference"]);
	});

	it("write → read → manifest counts match", async () => {
		await writeOkfPackage(tmpDir, [sampleMessage, sampleExperience, sampleOpinion], {
			packageVersion: "1.2.3",
		});
		const back = await readOkfPackage(tmpDir);
		expect(back.manifest?.okfConceptCount).toBe(3);
		const backCounts: Record<string, number> = {};
		for (const f of back.files) {
			const t = f.document.frontMatter.type;
			backCounts[t] = (backCounts[t] ?? 0) + 1;
		}
		expect(backCounts).toEqual(back.manifest?.okfTypeCounts);
	});
});

describe("readOkfPackage — manifest error surfacing", () => {
	it("surfaces a schema_mismatch issue when manifest.json fails to parse", async () => {
		await writeFile(join(tmpDir, "manifest.json"), "{ not valid json");
		await writeFile(
			join(tmpDir, "foo.md"),
			"---\ntype: Reference\ngenerated: { by: test, at: '2026-08-19T10:00:00Z' }\n---\nbody\n",
		);
		const result = await readOkfPackage(tmpDir);
		expect(result.manifest).toBeUndefined();
		expect(result.manifestIssues.some((i) => i.code === "schema_mismatch")).toBe(true);
	});

	it("surfaces a schema_mismatch issue when manifest.json violates the schema", async () => {
		// Missing required field `schema: "okf/v0.2"`.
		await writeFile(join(tmpDir, "manifest.json"), JSON.stringify({ name: "broken" }));
		const result = await readOkfPackage(tmpDir);
		expect(result.manifest).toBeUndefined();
		expect(result.manifestIssues.length).toBeGreaterThan(0);
		expect(result.manifestIssues.every((i) => i.code === "schema_mismatch")).toBe(true);
	});

	it("captures mtimeMs alongside the file", async () => {
		await writeFile(
			join(tmpDir, "foo.md"),
			"---\ntype: Reference\ngenerated: { by: test, at: '2026-08-19T10:00:00Z' }\n---\nbody\n",
		);
		const result = await readOkfPackage(tmpDir);
		expect(result.files[0]?.mtimeMs).toBeTypeOf("number");
		expect((result.files[0]?.mtimeMs ?? 0) > 0).toBe(true);
	});
});

describe("writeOkfPackage — overwrite semantics", () => {
	it("is idempotent: a second emit on the same root does not duplicate or overwrite", async () => {
		const first = await writeOkfPackage(tmpDir, [sampleMessage, sampleOpinion], {
			packageVersion: "1.2.3",
		});
		expect(first.written).toBe(2);
		const second = await writeOkfPackage(tmpDir, [sampleMessage, sampleOpinion], {
			packageVersion: "1.2.3",
		});
		expect(second.written).toBe(0);
		expect(second.skipped).toBe(2);
		expect((await readOkfPackage(tmpDir)).files.length).toBe(2);
	});

	it("overwrites when overwrite: true", async () => {
		await writeOkfPackage(tmpDir, [sampleMessage], { packageVersion: "1.0.0" });
		const second = await writeOkfPackage(tmpDir, [sampleMessage], {
			packageVersion: "2.0.0",
			overwrite: true,
		});
		expect(second.written).toBe(1);
		expect(second.skipped).toBe(0);
	});
});
