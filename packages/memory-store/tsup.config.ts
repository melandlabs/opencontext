import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		contracts: "src/contracts.ts",
		http: "src/http.ts",
		mcp: "src/mcp.ts",
		"storage/raw-message-store": "src/storage/raw-message-store.ts",
		"storage/sqlite-raw-message-store": "src/storage/sqlite-raw-message-store.ts",
		"storage/postgres-raw-message-factory": "src/storage/postgres-raw-message-factory.ts",
		"storage/sqlite-vector-index": "src/storage/sqlite-vector-index.ts",
		"storage/chroma-memory-index": "src/storage/chroma-memory-index.ts",
		"search/unified-search": "src/search/unified-search.ts",
		"policies/memory-graph-write-policy": "src/policies/memory-graph-write-policy.ts",
		"policies/memory-graph-correction-policy": "src/policies/memory-graph-correction-policy.ts",
		"server/cli-http": "src/server/cli-http.ts",
		"server/cli-mcp": "src/server/cli-mcp.ts",
		"server/cli-shared": "src/server/cli-shared.ts",
	},
	format: ["esm"],
	dts: true,
	sourcemap: true,
	clean: true,
	splitting: false,
	treeshake: true,
	shims: false,
	external: [
		"react",
		"react-dom",
		"@tauri-apps/api",
		"@tauri-apps/plugin-*",
		"better-sqlite3",
		"sqlite-vec",
		"server-only",
		// Optional peer — pulled in only when the daemon is started with
		// `--embedding-provider local` or `--*-backend=chroma`. Kept as a
		// runtime import so the published `dependencies` stay minimal; if
		// it's missing, the bin fails with a clear remediation hint.
		"@melandlabs/ai-rag",
		"@melandlabs/ai-rag/local-transformers-embedding-provider",
		"@melandlabs/ai-rag/chroma-store",
	],
});
