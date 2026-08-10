// Shared tsup preset for all OpenContext packages.
// Usage in a package's tsup.config.ts:
//
//   import { makeTsupConfig } from "@opencontext/config/tsup-preset";
//   export default makeTsupConfig({ entries: { "index": "src/index.ts" } });
//
// Keeping one source of truth so every published package:
//   - ships ESM + .d.ts
//   - keeps tree-shaking on
//   - excludes TypeScript source from the published tarball
//   - marks `react` / native deps as external by default

const DEFAULT_EXTERNALS = [
	"react",
	"react-dom",
	"@tauri-apps/api",
	"better-sqlite3",
	"sqlite-vec",
];

/**
 * @param {{
 *   entries: Record<string, string> | string[],
 *   external?: string[],
 *   cjs?: boolean,
 *   dts?: boolean,
 *   sourcemap?: boolean,
 * }} opts
 */
export function makeTsupConfig(opts) {
	const externals = Array.from(new Set([...DEFAULT_EXTERNALS, ...(opts.external ?? [])]));
	return {
		entry: opts.entries,
		format: opts.cjs ? ["esm", "cjs"] : ["esm"],
		dts: opts.dts ?? true,
		sourcemap: opts.sourcemap ?? true,
		clean: true,
		splitting: false,
		treeshake: true,
		external: externals,
	};
}
