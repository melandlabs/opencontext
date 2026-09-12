import { defineConfig } from "tsup";

/**
 * Multi-entry build for `@melandlabs/workspace`. Two entry points:
 *
 *   - `index`     — public surface (api, types, schema, sqlite helpers)
 *   - `cli`       — `opencontext workspace …` subcommand for local indexing + search
 *   - `sqlite`    — convenience entry so tests and internal callers can
 *                   `import "@melandlabs/workspace/sqlite"` without dragging
 *                   the rest of the barrel
 */
export default defineConfig({
	entry: {
		index: "src/index.ts",
		sqlite: "src/sqlite.ts",
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
