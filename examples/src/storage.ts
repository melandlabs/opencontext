/**
 * Persistence packages.
 *
 * @melandlabs/storage (local fs + vercel blob adapters), @melandlabs/sqlite
 * (raw-message persistence), and @melandlabs/indexeddb (browser storage).
 * We do not actually write to disk here — just verify the modules load
 * and the main classes/adapters are exported.
 */

import * as storage from "@melandlabs/storage";
import * as sqlite from "@melandlabs/sqlite";
import * as indexeddb from "@melandlabs/indexeddb";
import { makeCheck, runSection } from "./_helpers.ts";

export default async function testStorage() {
	await runSection("@melandlabs/storage", async () => {
		const check = makeCheck("storage");
		check("LocalStorageProvider is a class", typeof storage.LocalStorageProvider === "function");
		const exported = Object.keys(storage).filter((k) => !k.startsWith("_"));
		check("storage exports at least 1 symbol", exported.length >= 1);

		// Note: storage's `./adapters` subpath export points to
		// `./dist/adapters/index.js` but tsup flattens the entry filenames to
		// `./dist/adapters-index.js`. The published package's exports field
		// is therefore stale; consumers should rely on the main entry plus
		// `./local` and `./provider` subpaths which do resolve.
		try {
			const adapters = (await import("@melandlabs/storage/adapters")) as Record<string, unknown>;
			check("storage/adapters exposes uploadToLocalFs", typeof adapters.uploadToLocalFs === "function");
			check("storage/adapters exposes uploadToVercelBlob", typeof adapters.uploadToVercelBlob === "function");
		} catch (err) {
			check("storage/adapters loads (known issue: stale exports path)", false, `import failed: ${(err as Error).message}`);
		}
	});

	await runSection("@melandlabs/sqlite", async () => {
		const check = makeCheck("sqlite");
		check("SQLiteRawMessageManager is a class", typeof sqlite.SQLiteRawMessageManager === "function");
		check(
			"initializeRawMessageSchema is a function",
			typeof sqlite.initializeRawMessageSchema === "function",
		);
	});

	await runSection("@melandlabs/indexeddb", async () => {
		const check = makeCheck("indexeddb");
		const exported = Object.keys(indexeddb).filter((k) => !k.startsWith("_"));
		check("indexeddb exports symbols", exported.length > 0);
	});
}
