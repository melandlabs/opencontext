import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { APP_DIR_NAME } from "./client-constants";

export const OPENCONTEXT_HOME_ENV = "OPENCONTEXT_HOME";

function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

/** 根目录：OPENCONTEXT_HOME 覆盖（支持 ~/ 展开）→ 默认 ~/.opencontext */
export function getOpenContextDir(): string {
	const override = process.env.OPENCONTEXT_HOME?.trim();
	if (override && override.length > 0) return resolve(expandHome(override));
	return join(homedir(), APP_DIR_NAME);
}

/** 纯拼接，不做 fs 操作 */
export function getOpenContextPath(...segments: string[]): string {
	return join(getOpenContextDir(), ...segments);
}

/** mkdir -p 并返回路径（建目录的统一入口） */
export function ensureOpenContextDir(...segments: string[]): string {
	const dir = segments.length === 0 ? getOpenContextDir() : join(getOpenContextDir(), ...segments);
	mkdirSync(dir, { recursive: true });
	return dir;
}
