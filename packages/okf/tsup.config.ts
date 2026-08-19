import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		http: "src/http.ts",
		mcp: "src/mcp.ts",
	},
	format: ["esm"],
	dts: true,
	sourcemap: false,
	clean: true,
	splitting: false,
	treeshake: true,
	// Keep these external so the consumer's bundled copy (and the
	// opencontext facade's tsup) doesn't double-load zod / hono / the
	// memory-store's optional connections.
	external: [
		"yaml",
		"zod",
		"hono",
		"@hono/node-server",
		"@modelcontextprotocol/sdk",
		"@melandlabs/contracts",
		"@melandlabs/indexeddb",
		"@melandlabs/memory-store",
	],
});
