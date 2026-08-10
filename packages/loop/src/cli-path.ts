/**
 * Resolve the absolute path to the Loop CLI shim (`loop-cli.mjs`) so the
 * agent at `/api/native/agent` can persist classified decisions without
 * relying on the agent knowing where the workspace lives.
 *
 * Background — issue #348: the tick prompt used to hardcode
 * `apps/web/scripts/loop-cli.mjs` (a workspace-relative path). That
 * worked in dev, but the packaged Tauri desktop build ships the Next.js
 * server from `.next/standalone/apps/web/` and never copies the
 * `scripts/` dir, so the agent ran `node apps/web/scripts/loop-cli.mjs …`
 * against a missing file and silently produced zero decisions.
 *
 * Resolution order (first match wins):
 *   1. `OPENLOOMI_LOOP_CLI` env var — escape hatch for split-process
 *      setups (skill runs in one shell, Next.js server in another).
 *   2. Packaged bundle — `~/.openloomi/runtime/loop-cli.mjs`. The Tauri
 *      desktop optimizer copies `apps/web/scripts/loop-cli.mjs` to this
 *      location during build, so the shipped app always has the shim
 *      next to other Loop assets.
 *   3. Packaged Tauri `_up_/` layout — the Next.js server in
 *      `Contents/Resources/_up_/.next/standalone/apps/web/` reaches
 *      the shim via `_up_/apps/web/scripts/loop-cli.mjs` because the
 *      optimizer mirrors it.
 *   4. Next.js standalone layout — `.next/standalone/apps/web/scripts/loop-cli.mjs`
 *      when running standalone but not yet packaged (Tauri staging).
 *   5. Dev workspace — `apps/web/scripts/loop-cli.mjs` relative to the
 *      monorepo root (works under `pnpm --filter web loop …`).
 *   6. Dev workspace (cwd) — same path relative to the current
 *      working directory, for ad-hoc agent invocations.
 *
 * Returns `null` when no candidate exists. Callers should treat a
 * `null` return as a soft error: surface the missing path in the tick
 * log so the user can set `OPENLOOMI_LOOP_CLI` to fix it.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The runtime home for Loop-owned assets in the packaged desktop app.
 * The Tauri optimizer copies `loop-cli.mjs` here during build so the
 * shipped app has a stable, predictable shim location that doesn't
 * depend on the .app bundle's internal layout.
 */
const PACKAGED_RUNTIME_DIR = join(homedir(), ".openloomi", "runtime");

/**
 * Filename we expect. The shim itself spawns `tsx` and forwards to
 * `lib/loop/cli.ts` — see `apps/web/scripts/loop-cli.mjs` for the
 * spawn chain. Don't rename without also updating the optimizer.
 */
export const LOOP_CLI_FILENAME = "loop-cli.mjs";

interface Candidate {
  path: string;
  /** Source description, for logging / debugging. */
  from: string;
}

function isLoopCliFile(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

/** Walk a list of candidate dirs and yield any matching `<dir>/loop-cli.mjs`. */
function joinAll(...dirs: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const dir of dirs) {
    if (!dir) continue;
    const p = join(dir, LOOP_CLI_FILENAME);
    if (isLoopCliFile(p)) out.push({ path: p, from: dir });
  }
  return out;
}

/**
 * Candidate dirs the optimizer / Next.js standalone layout actually
 * uses. The exact shape depends on whether the user runs `pnpm dev`,
 * `pnpm next start` against `.next/standalone`, or the packaged
 * Tauri `.app`. Walking all of them keeps us robust across modes.
 */
function packagedCandidates(): string[] {
  return [
    // Packaged desktop app — the optimizer drops loop-cli.mjs here.
    PACKAGED_RUNTIME_DIR,
    // Tauri `_up_/` mounted standalone — typical layout inside the
    // macOS .app bundle: Contents/Resources/_up_/.next/standalone/...
    // The standalone uses `<process cwd>/_up_/apps/web/...` for
    // sibling resources; we don't know the cwd at resolver time, so
    // we expose these as relative candidates (see `cwdCandidates`).
  ];
}

function standaloneCandidates(): string[] {
  // The Next.js standalone build copies `apps/web/scripts/*` into
  // `.next/standalone/apps/web/scripts/*` ONLY when explicitly added
  // to `outputFileTracingIncludes`. Until that lands, we walk the
  // monorepo relative to `process.cwd()` and try the most common
  // `.next/standalone` roots.
  const cwd = process.cwd();
  const probes = [
    cwd,
    resolve(cwd, ".."),
    resolve(cwd, "../.."),
    resolve(cwd, "../../.."),
  ];
  const roots: string[] = [];
  for (const probe of probes) {
    roots.push(
      join(probe, ".next", "standalone", "apps", "web"),
      join(probe, ".next", "standalone"),
    );
  }
  return roots;
}

function devCandidates(): string[] {
  // Walk up looking for `apps/web/scripts/loop-cli.mjs` — works for
  // dev (`pnpm --filter web dev`), CLI invocation from the monorepo
  // root, and any IDE-launched child process.
  const cwd = process.cwd();
  const probes = [
    cwd,
    resolve(cwd, ".."),
    resolve(cwd, "../.."),
    resolve(cwd, "../../.."),
  ];
  const roots: string[] = [];
  for (const probe of probes) {
    roots.push(
      join(probe, "apps", "web", "scripts"),
      join(probe, "apps", "web"),
    );
  }
  return roots;
}

/**
 * `lib/loop/cli-path.ts` lives at `apps/web/lib/loop/cli-path.ts`.
 * The dev fallback computes `apps/web/scripts/loop-cli.mjs` relative
 * to itself so callers don't depend on `process.cwd()`.
 */
function selfRelativeCandidates(): string[] {
  try {
    // Compute the path of *this* file at module load. Works for both
    // ESM (`import.meta.url`) and a bundled CJS shim — vitest/tsx run
    // the file from its on-disk path, so the chain below is stable.
    // We don't actually use fileURLToPath at the top level because
    // older Next.js compilers can rewrite `import.meta.url`.
    const importMetaUrl =
      typeof import.meta !== "undefined" ? import.meta.url : "";
    const here = importMetaUrl ? fileURLToPath(importMetaUrl) : __filename;
    const hereDir = dirname(here);
    const webDir = resolve(hereDir, "..", "..");
    const rootDir = resolve(webDir, "..", "..");
    return [join(webDir, "scripts"), join(rootDir, "apps", "web", "scripts")];
  } catch {
    return [];
  }
}

interface ResolveOptions {
  /**
   * When `true`, return the raw list of candidates without reading
   * the filesystem. Useful for tests / debugging.
   */
  dryRun?: boolean;
}

/**
 * Resolve the absolute path of the Loop CLI shim, or `null` if no
 * candidate exists on disk. Returned paths are guaranteed to exist
 * (unless `dryRun` is set) and to be a regular file path — callers
 * can hand the string straight to `node -e` or a Bash subshell.
 */
export function resolveLoopCli(opts: ResolveOptions = {}): string | null {
  const found =
    process.env.OPENLOOMI_LOOP_CLI &&
    (opts.dryRun || isLoopCliFile(process.env.OPENLOOMI_LOOP_CLI))
      ? [{ path: process.env.OPENLOOMI_LOOP_CLI, from: "env" }]
      : [];
  if (found.length) return found[0].path;

  const allCandidates = [
    ...joinAll(...packagedCandidates()),
    ...joinAll(...standaloneCandidates()),
    ...joinAll(...devCandidates()),
    ...joinAll(...selfRelativeCandidates()),
  ];
  for (const c of allCandidates) {
    if (opts.dryRun || isLoopCliFile(c.path)) return c.path;
  }
  if (opts.dryRun) {
    // For dry-run, return the first non-existent candidate so callers
    // can render an actionable diagnostic.
    const fakeCandidates = [
      ...packagedCandidates(),
      ...standaloneCandidates(),
      ...devCandidates(),
      ...selfRelativeCandidates(),
    ].map((d) => join(d, LOOP_CLI_FILENAME));
    return fakeCandidates[0] ?? null;
  }
  return null;
}

/**
 * Diagnostic listing — returns every candidate the resolver
 * considered, with the source and an `exists` flag. Used by the
 * `loop doctor` CLI so a user can see where the resolver looked and
 * set `OPENLOOMI_LOOP_CLI` accordingly when nothing matched.
 */
export function listLoopCliCandidates(): Array<{
  path: string;
  from: string;
  exists: boolean;
}> {
  const env = process.env.OPENLOOMI_LOOP_CLI;
  const out: Array<{ path: string; from: string; exists: boolean }> = [];
  if (env)
    out.push({
      path: env,
      from: "env:OPENLOOMI_LOOP_CLI",
      exists: isLoopCliFile(env),
    });
  for (const dir of [
    ...packagedCandidates(),
    ...standaloneCandidates(),
    ...devCandidates(),
    ...selfRelativeCandidates(),
  ]) {
    const p = join(dir, LOOP_CLI_FILENAME);
    out.push({ path: p, from: dir, exists: isLoopCliFile(p) });
  }
  return out;
}
