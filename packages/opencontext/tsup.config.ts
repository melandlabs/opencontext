import { defineConfig } from "tsup";

// @melandlabs/opencontext — single-package facade.
//
// tsup bundles every workspace @melandlabs/* package into one ESM file so the
// published artifact has zero npm-side workspace runtime dependencies.
// Third-party packages (zod, hono, better-sqlite3, …) stay external — they
// ship as normal `dependencies` in the manifest and pnpm resolves them for
// consumers at install time.
//
// `pg` is also external: it's a CommonJS-only package and tsup's bundler
// wraps it in `__commonJS` shims that throw `Dynamic require of "events"
// is not supported` when the bin scripts run under Node. Marking it
// external preserves a real `import { x } from "pg"` so Node's resolver
// handles it.

export default defineConfig({
	entry: {
		index: "src/index.ts",
		"cli/opencontext": "src/cli/opencontext.ts",
	},
	format: ["esm"],
	dts: true,
	sourcemap: true,
	clean: true,
	splitting: false,
	treeshake: true,
	target: "esnext",
	noExternal: [/^@melandlabs\//],
	external: ["pg"],
});
