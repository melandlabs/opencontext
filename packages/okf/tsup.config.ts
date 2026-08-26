import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "tsup";

const VIEWER_SRC = resolve(__dirname, "src", "viewer");
const VIEWER_OUT = resolve(__dirname, "dist", "viewer");

/**
 * Copy the opencontext OKF viewer (`src/viewer/`) into
 * `dist/viewer/` after every build so `startOkfServe` can find
 * the static assets next to `dist/serve.js`. tsup doesn't run a
 * `postbuild` step natively, so we hook `onSuccess` to invoke
 * `node:fs` directly.
 */
function copyViewerAssets(): void {
	mkdirSync(VIEWER_OUT, { recursive: true });
	cpSync(VIEWER_SRC, VIEWER_OUT, { recursive: true });
}

export default defineConfig({
	entry: {
		index: "src/index.ts",
		http: "src/http.ts",
		mcp: "src/mcp.ts",
		serve: "src/serve.ts",
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
	onSuccess: copyViewerAssets,
});
