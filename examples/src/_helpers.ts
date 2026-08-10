/**
 * Shared helpers for the @melandlabs/opencontext smoke tests.
 *
 * Each package test file exports a default async function that runs its
 * assertions, calling `check(...)` or `skip(...)` from this module. A
 * non-zero exit code is set whenever any `check(...)` fails, so
 * `pnpm test` (which just runs `node --experimental-strip-types src/index.ts`)
 * surfaces failures to CI.
 *
 * `skip(...)` is used for packages whose upstream dependency ships CJS
 * without an `exports` field (telegram, @whiskeysockets/baileys,
 * @xdevplatform/xdk, @larksuiteoapi/node-sdk, @tencent-weixin/openclaw-weixin).
 * Node 22 ESM rejects bare subpath imports from those packages at module
 * load, so they cannot be smoke-tested here — the failure is expected
 * and does not affect the exit code.
 */

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
 * Wrap a section so failures are reported under a clear heading.
 */
export async function runSection(label: string, fn: PackageTest) {
	console.log(`\n── ${label} ──`);
	await fn();
}
