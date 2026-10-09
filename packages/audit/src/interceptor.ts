/**
 * Audit interceptor
 *
 * Automatically records non-project file reads and local command executions
 * during program runtime by replacing key methods of Node.js native fs / child_process modules.
 *
 * Call installAuditInterceptors() in instrumentation.ts's register()
 * to activate on server startup.
 *
 * Note: Node.js modules are imported statically. This module is only ever
 * loaded from `instrumentation.ts` (which gates on `NEXT_RUNTIME === "nodejs"`),
 * so Edge Runtime bundling is not a concern.
 */

import cp from "node:child_process";
import fs from "node:fs";
import { resolve } from "node:path";

import { getOpenContextDir } from "@melandlabs/env-config/app-paths";

import { logCommandExec, logFileRead } from "./logger";

// The `fs` / `cp` imports above MUST stay default imports. `import * as fs` binds
// an ES module namespace object, whose properties are getter-only accessors:
// assigning to one throws "TypeError: Cannot set property readFileSync of [object
// Module] which has only a getter" whenever the bundle preserves ESM semantics
// (Next.js server chunks, Turbopack, Vite). The default import is the live
// CommonJS exports object — mutable, and shared process-wide, so it is the only
// form that intercepts anything. Keep the aliases below for the assignment type:
// @types/node marks `fs.readFile` / `cp.exec` with a `__promisify__` property the
// plain-function wrappers do not carry.
// biome-ignore lint/suspicious/noExplicitAny: target of monkey-patch needs `any`
const fsMutable = fs as any;
// biome-ignore lint/suspicious/noExplicitAny: target of monkey-patch needs `any`
const cpMutable = cp as any;

let installed = false;
let projectRoot = "";

/**
 * Determine if a file path belongs to "non-project"
 * - Files within project directory are not recorded
 * - node_modules / .next / .opencontext directories are not recorded
 */
function isNonProjectPath(filePath: string): boolean {
	try {
		const resolved = resolve(String(filePath));
		if (resolved.includes("node_modules") || resolved.includes(".next")) {
			return false;
		}
		if (resolved.startsWith(projectRoot)) {
			return false;
		}
		// Skip ~/.opencontext app data directory
		const opencontextDir = getOpenContextDir();
		if (resolved.startsWith(opencontextDir)) {
			return false;
		}
		// Skip /dev/null, /proc and other system pseudo-files
		if (resolved.startsWith("/dev/") || resolved.startsWith("/proc/") || resolved.startsWith("/sys/")) {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Install audit interceptors - runs only once on Node.js server-side
 */
export function installAuditInterceptors() {
	if (installed) return;
	installed = true;

	try {
		projectRoot = resolve(globalThis.process.cwd());
		// If started from apps/web, project root is two levels up
		if (projectRoot.endsWith("/apps/web") || projectRoot.endsWith("\\apps\\web")) {
			projectRoot = resolve(projectRoot, "..", "..");
		}

		// ────────── Save original function ──────────
		const origReadFileSync = fs.readFileSync;
		const origReadFile = fs.readFile;
		const origExecSync = cp.execSync;
		const origExec = cp.exec;
		const origSpawn = cp.spawn;
		const origSpawnSync = cp.spawnSync;

		// ────────── Intercept fs.readFileSync ──────────
		fsMutable.readFileSync = function auditedReadFileSync(path: unknown, ...args: unknown[]) {
			try {
				const p = String(path);
				if (isNonProjectPath(p)) {
					logFileRead(resolve(p));
				}
			} catch {
				// Does not affect original call
			}
			// biome-ignore lint/complexity/noBannedTypes: forwarding arbitrary args through Function.apply
			return (origReadFileSync as Function).apply(fs, [path, ...args]);
		};

		// ────────── Intercept fs.readFile ──────────
		fsMutable.readFile = function auditedReadFile(path: unknown, ...args: unknown[]) {
			try {
				const p = String(path);
				if (isNonProjectPath(p)) {
					logFileRead(resolve(p));
				}
			} catch {
				// Does not affect original call
			}
			// biome-ignore lint/complexity/noBannedTypes: forwarding arbitrary args through Function.apply
			return (origReadFile as Function).apply(fs, [path, ...args]);
		};

		// Intercept fs.promises.readFile
		if (fs.promises) {
			const origPromisesReadFile = fs.promises.readFile;
			// biome-ignore lint/suspicious/noExplicitAny: monkey-patching fs.promises.readFile
			const promisesMutable = fs.promises as any;
			promisesMutable.readFile = function auditedPromisesReadFile(path: unknown, ...args: unknown[]) {
				try {
					const p = String(path);
					if (isNonProjectPath(p)) {
						logFileRead(resolve(p));
					}
				} catch {
					// Does not affect original call
				}
				// biome-ignore lint/complexity/noBannedTypes: forwarding arbitrary args through Function.apply
				return (origPromisesReadFile as Function).apply(fs.promises, [path, ...args]);
			};
		}

		// ────────── Intercept child_process.execSync ──────────
		cpMutable.execSync = function auditedExecSync(command: unknown, ...args: unknown[]) {
			try {
				logCommandExec(String(command));
			} catch {
				// Does not affect original call
			}
			// biome-ignore lint/complexity/noBannedTypes: forwarding arbitrary args through Function.apply
			return (origExecSync as Function).apply(cp, [command, ...args]);
		};

		// ────────── Intercept child_process.exec ──────────
		cpMutable.exec = function auditedExec(command: unknown, ...args: unknown[]) {
			try {
				logCommandExec(String(command));
			} catch {
				// Does not affect original call
			}
			// biome-ignore lint/complexity/noBannedTypes: forwarding arbitrary args through Function.apply
			return (origExec as Function).apply(cp, [command, ...args]);
		};

		// ────────── Intercept child_process.spawn ──────────
		cpMutable.spawn = function auditedSpawn(command: unknown, spawnArgs?: unknown, ...rest: unknown[]) {
			try {
				const argsArr = Array.isArray(spawnArgs) ? spawnArgs.map(String) : undefined;
				logCommandExec(String(command), argsArr);
			} catch {
				// Does not affect original call
			}
			// biome-ignore lint/complexity/noBannedTypes: forwarding arbitrary args through Function.apply
			return (origSpawn as Function).apply(cp, [command, spawnArgs, ...rest]);
		};

		// ────────── Intercept child_process.spawnSync ──────────
		cpMutable.spawnSync = function auditedSpawnSync(
			command: unknown,
			spawnArgs?: unknown,
			...rest: unknown[]
		) {
			try {
				const argsArr = Array.isArray(spawnArgs) ? spawnArgs.map(String) : undefined;
				logCommandExec(String(command), argsArr);
			} catch {
				// Does not affect original call
			}
			// biome-ignore lint/complexity/noBannedTypes: forwarding arbitrary args through Function.apply
			return (origSpawnSync as Function).apply(cp, [command, spawnArgs, ...rest]);
		};
	} catch (e) {
		// biome-ignore lint/suspicious/noConsole: error logging
		console.error("[Audit] Error:", e);
	}
}
