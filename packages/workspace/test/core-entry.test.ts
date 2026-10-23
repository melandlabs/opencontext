import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

/**
 * `@melandlabs/workspace/core` promises to be free of native code.
 *
 * The promise exists because the root barrel re-exports the SQLite
 * store, and the SQLite store imports `better-sqlite3` at module load.
 * A host that serves the index from Postgres never touches a SQLite
 * file, but a bundler cannot tree-shake a native module out of a
 * re-exported binding — so the only way to keep it out of the bundle is
 * to not reach it at all.
 *
 * This test walks the *built* module graph of the `core` entry and
 * fails if a native module shows up anywhere in it. Checking the source
 * would not be enough: the graph that ships is the one esbuild emits.
 */

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");

/** External specifiers imported by a built file. */
function externalImports(file: string): string[] {
	const source = readFileSync(file, "utf8");
	const specifiers: string[] = [];
	const pattern = /(?:^|\n)\s*import\s+(?:[^'"]*?\sfrom\s*)?["']([^"']+)["']/g;
	for (const match of source.matchAll(pattern)) {
		const specifier = match[1];
		if (specifier !== undefined) specifiers.push(specifier);
	}
	return specifiers;
}

/** Every file reachable from `entry` through relative imports. */
function reachable(entry: string): string[] {
	const seen = new Set<string>();
	const queue = [entry];
	while (queue.length > 0) {
		const file = queue.pop();
		if (file === undefined) break;
		if (seen.has(file)) continue;
		seen.add(file);
		for (const specifier of externalImports(file)) {
			if (!specifier.startsWith(".")) continue;
			queue.push(resolve(dirname(file), specifier));
		}
	}
	return [...seen];
}

it("keeps native modules out of the core entry's module graph", () => {
	const files = reachable(resolve(DIST, "core.js"));
	expect(files.length).toBeGreaterThan(0);

	const native: string[] = [];
	for (const file of files) {
		for (const specifier of externalImports(file)) {
			if (specifier === "better-sqlite3" || specifier === "sqlite-vec") {
				native.push(`${file} → ${specifier}`);
			}
		}
	}

	expect(native).toEqual([]);
});

it("keeps native modules out of the postgres entry's module graph", () => {
	const files = reachable(resolve(DIST, "postgres.js"));

	const native: string[] = [];
	for (const file of files) {
		for (const specifier of externalImports(file)) {
			if (specifier === "better-sqlite3" || specifier === "sqlite-vec") {
				native.push(`${file} → ${specifier}`);
			}
		}
	}

	expect(native).toEqual([]);
});

it("still loads the SQLite store from the sqlite entry", () => {
	const files = reachable(resolve(DIST, "sqlite.js"));
	const specifiers = files.flatMap((file) => externalImports(file));

	expect(specifiers).toContain("better-sqlite3");
});

it("serves the pure surface from the core entry", async () => {
	const core = await import("@melandlabs/workspace/core");

	expect(typeof core.fuseHybridHits).toBe("function");
	expect(typeof core.workspaceEmbedQuery).toBe("function");
	expect(typeof core.listOkfFolderResources).toBe("function");
	expect(typeof core.extractText).toBe("function");
	expect(typeof core.buildCitationId).toBe("function");
});
