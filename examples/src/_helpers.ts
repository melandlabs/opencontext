/**
 * Shared helpers for the @melandlabs/opencontext smoke tests.
 *
 * Each package test file exports a default async function that runs its
 * assertions, calling `check(...)` from this module. A non-zero exit code
 * is set whenever any check fails, so `pnpm test` (which just runs
 * `node --experimental-strip-types src/index.ts`) surfaces failures to CI.
 */

export type Check = (label: string, ok: boolean, detail?: string) => void;

export function makeCheck(prefix: string): Check {
	return (label, ok, detail) => {
		const tag = ok ? "OK  " : "FAIL";
		const suffix = detail ? ` (${detail})` : "";
		console.log(`[${tag}] ${prefix}: ${label}${suffix}`);
		if (!ok) process.exitCode = 1;
	};
}

export type PackageTest = () => Promise<void> | void;

/**
 * Wrap a section so failures are reported under a clear heading.
 */
export async function runSection(label: string, fn: PackageTest) {
	console.log(`\n── ${label} ──`);
	await fn();
}
