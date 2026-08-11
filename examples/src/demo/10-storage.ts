/**
 * demo: @melandlabs/storage — the local filesystem provider.
 *
 * `StorageProvider` is a small binary blob interface — `initialize`,
 * `save`, `load`, `exists`, `delete` — with interchangeable backends.
 * `LocalStorageProvider` is the filesystem one; a Vercel Blob adapter
 * implements the same contract, so calling code doesn't change.
 *
 * Two things to know about the local provider:
 *
 *   - Its storage root is `path.resolve("data", "storage")`, resolved
 *     from `process.cwd()` *at module load*. It is process-wide and
 *     cannot be reconfigured per instance.
 *   - Keys are sanitised: `/` and `\` are replaced with `_`, so a key
 *     like `../../etc/passwd` cannot escape the storage directory.
 *
 * Because the root is cwd-relative and fixed at import time, this demo
 * runs in a child process with its cwd set to a scratch directory. That
 * keeps `examples/data/storage/` from being created in your checkout
 * while still exercising the real provider end to end.
 */

import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { info, makeCheck, runSection, withTmp } from "../_helpers.ts";

/** Runs in a child process whose cwd is a scratch directory. */
const CHILD = `
import { LocalStorageProvider } from "@melandlabs/storage";
import { existsSync } from "node:fs";
import * as path from "node:path";

const store = new LocalStorageProvider();
await store.initialize();

const root = path.resolve("data", "storage");
const payload = new TextEncoder().encode("hello from the storage demo");

const existsBefore = await store.exists("greeting.txt");
await store.save("greeting.txt", payload);
const existsAfter = await store.exists("greeting.txt");

const loaded = await store.load("greeting.txt");
const roundTripped = new TextDecoder().decode(loaded);

// Path-traversal keys are sanitised into a flat filename.
await store.save("../../escape-attempt", new TextEncoder().encode("nope"));
const escapedOutside = existsSync(path.resolve("..", "..", "escape-attempt"));
const sanitisedInside = existsSync(path.join(root, ".._.._escape-attempt"));

await store.delete("greeting.txt");
const existsAfterDelete = await store.exists("greeting.txt");

console.log("__DEMO__" + JSON.stringify({
  root,
  cwd: process.cwd(),
  existsBefore,
  existsAfter,
  existsAfterDelete,
  sentBytes: payload.length,
  loadedBytes: loaded.length,
  roundTripped,
  escapedOutside,
  sanitisedInside,
}));
`;

export default async function demoStorage() {
	await runSection("demo: @melandlabs/storage", async () => {
		const check = makeCheck("demo/storage");

		await withTmp("storage", async (dir) => {
			const raw = execFileSync(
				process.execPath,
				["--experimental-strip-types", "--input-type=module", "-e", CHILD],
				{ cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
			);
			const line = raw.split("\n").find((l) => l.startsWith("__DEMO__"));
			const out = JSON.parse((line as string).slice("__DEMO__".length));

			info("demo/storage", `storage root resolved to ${out.root}`);
			info("demo/storage", `saved ${out.sentBytes} bytes, loaded back ${out.loadedBytes} bytes`);
			info("demo/storage", `round-tripped value: ${JSON.stringify(out.roundTripped)}`);

			check(
				"the storage root is cwd-relative (data/storage)",
				out.root === path.join(out.cwd, "data", "storage"),
				out.root,
			);
			check("exists() is false before anything is saved", out.existsBefore === false);
			check("exists() is true after save()", out.existsAfter === true);
			check(
				"load() returns exactly the bytes save() was given",
				out.loadedBytes === out.sentBytes,
				`${out.loadedBytes} bytes`,
			);
			check(
				"the payload survives the round trip byte-for-byte",
				out.roundTripped === "hello from the storage demo",
			);
			check("delete() removes the blob — exists() goes back to false", out.existsAfterDelete === false);

			// The security property, actually exercised.
			check("a '../../' key cannot write outside the storage root", out.escapedOutside === false);
			check(
				"it is sanitised into a flat filename inside the root instead",
				out.sanitisedInside === true,
			);
		});
	});
}
