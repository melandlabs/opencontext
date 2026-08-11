/**
 * Shared helpers for the @melandlabs/opencontext examples.
 *
 * Two layers use these:
 *   - `demo/*.ts`  — runnable documentation. Each file actually calls a
 *     package's public API and asserts on the real return value.
 *   - `smoke/*.ts` — export-shape verification. Each file confirms a
 *     package resolves and exposes the symbols consumers import.
 *
 * Both export a default async function that runs its assertions, calling
 * `check(...)` or `skip(...)` from this module. A non-zero exit code is set
 * whenever any `check(...)` fails, so `pnpm test` (which just runs
 * `node --experimental-strip-types src/index.ts`) surfaces failures to CI.
 *
 * `skip(...)` records an expected non-failure: a missing API key, an
 * optional native module that didn't build, or a package whose upstream
 * dependency ships CJS without an `exports` field (telegram,
 * @whiskeysockets/baileys, @xdevplatform/xdk, @larksuiteoapi/node-sdk,
 * @tencent-weixin/openclaw-weixin). Node 22 ESM rejects bare subpath
 * imports from those packages at module load. Skips do not affect the
 * exit code.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export type Check = (label: string, ok: boolean, detail?: string) => void;
export type Skip = (label: string, reason: string, detail?: string) => void;

/**
 * Create a `check` function for a given package. A non-zero exit code
 * is set whenever any check fails. See `makeCheckWithSkip` if you also
 * need to record expected skips (e.g. packages whose upstream dependency
 * ships CJS without an ESM `exports` field).
 */
export function makeCheck(prefix: string): Check {
	return (label, ok, detail) => {
		const tag = ok ? "OK  " : "FAIL";
		const suffix = detail ? ` (${detail})` : "";
		console.log(`[${tag}] ${prefix}: ${label}${suffix}`);
		if (!ok) process.exitCode = 1;
	};
}

export interface CheckWithSkip {
	check: Check;
	skip: Skip;
}

/**
 * Like `makeCheck` but also returns a `skip` function for reporting
 * expected failures (e.g. upstream CJS-only packages that cannot be
 * loaded under Node's strict ESM). Skipped checks do not affect the
 * exit code.
 */
export function makeCheckWithSkip(prefix: string): CheckWithSkip {
	const check: Check = (label, ok, detail) => {
		const tag = ok ? "OK  " : "FAIL";
		const suffix = detail ? ` (${detail})` : "";
		console.log(`[${tag}] ${prefix}: ${label}${suffix}`);
		if (!ok) process.exitCode = 1;
	};
	const skip: Skip = (label, reason, detail) => {
		const tag = "SKIP";
		const suffix = detail ? ` (${detail})` : "";
		console.log(`[${tag}] ${prefix}: ${label}${suffix}`);
		void reason;
	};
	return { check, skip };
}

export type PackageTest = () => Promise<void> | void;

/**
 * Print an observational line (e.g. "encrypted 5 bytes of plaintext").
 * Demos use this to show the real values an API returned, which is the
 * point of the demo layer. Never affects the exit code.
 */
export function info(prefix: string, message: string): void {
	console.log(`[INFO] ${prefix}: ${message}`);
}

/** Scratch directory for demos that touch the filesystem. */
export const TMP_ROOT = path.resolve(import.meta.dirname, "..", ".tmp");

/**
 * Run `fn` against a fresh scratch directory, removing it afterwards even
 * if `fn` throws. Demos that write real files (sqlite, storage, loop)
 * go through this so `examples/.tmp/` is empty once the run finishes.
 */
export async function withTmp<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
	const unique = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const dir = path.join(TMP_ROOT, unique);
	await fs.mkdir(dir, { recursive: true });
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
		// Drop `.tmp` itself when this was the last demo using it.
		await fs.rmdir(TMP_ROOT).catch(() => {});
	}
}

/**
 * Wrap a section so failures are reported under a clear heading.
 */
export async function runSection(label: string, fn: PackageTest) {
	console.log(`\n── ${label} ──`);
	await fn();
}
