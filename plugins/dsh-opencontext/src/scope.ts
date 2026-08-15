/**
 * scope — auto-detect a project-scope id from the agent's cwd.
 *
 * Strategy: hash the absolute cwd into a short, stable, opaque id of
 * the form `local:<12hex>`. This is good enough as a partition key for
 * the lib backend's user-id field — a different working directory
 * gets a different namespace, so memory captured in one project
 * does not leak into another.
 *
 * When `config.scopeId` is already set, it is returned verbatim.
 */

import { createHash } from "node:crypto";

export function autoScopeId(cwd: string): string {
	const supplied = typeof cwd === "string" ? cwd.trim() : "";
	if (!supplied) return "local:default";
	const hash = createHash("sha256").update(supplied).digest("hex").slice(0, 12);
	return `local:${hash}`;
}

export function resolveScopeId(configScope: string | undefined, cwd: string): string {
	if (configScope && configScope.length > 0) return configScope;
	return autoScopeId(cwd);
}
