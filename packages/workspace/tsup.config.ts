import { defineConfig } from "tsup";

/**
 * Multi-entry build for `@melandlabs/workspace`. Five entry points:
 *
 *   - `index`     — public surface (api, types, schema, sqlite helpers)
 *   - `core`      — the backend-agnostic surface, free of native code.
 *                   The root barrel re-exports the SQLite store, so
 *                   importing *anything* from it loads `better-sqlite3`
 *                   at import time; a host that never touches a SQLite
 *                   file — a serverless deployment on the Postgres
 *                   backend — imports from here instead.
 *   - `cli`       — `opencontext workspace …` subcommand for local indexing + search
 *   - `sqlite`    — convenience entry so tests and internal callers can
 *                   `import "@melandlabs/workspace/sqlite"` without dragging
 *                   the rest of the barrel
 *   - `postgres`  — the Postgres backend. Deliberately separate from the
 *                   root barrel so a serverless host never pulls
 *                   `better-sqlite3` (a native module) into its bundle.
 */
export default defineConfig({
	entry: {
		index: "src/index.ts",
		core: "src/core.ts",
		sqlite: "src/sqlite.ts",
		postgres: "src/postgres/index.ts",
		cli: "src/cli.ts",
	},
	format: ["esm"],
	dts: true,
	sourcemap: false,
	clean: true,
	splitting: false,
	treeshake: true,
	external: [
		"react",
		"react-dom",
		"better-sqlite3",
		"sqlite-vec",
		"hono",
		"pg",
		"zod",
		"@modelcontextprotocol/sdk",
		"@hono/node-server",
		"@melandlabs/ai-rag",
		"@melandlabs/contracts",
		"@melandlabs/okf",
		"@melandlabs/rag",
		"@melandlabs/shared",
		"@melandlabs/sqlite",
	],
});
