import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		chunking: "src/chunking.ts",
		embeddings: "src/embeddings.ts",
		"vector-service": "src/vector-service.ts",
		parsers: "src/parsers.ts",
		"universal-embeddings": "src/universal-embeddings.ts",
		"sqlite-vec-store": "src/sqlite-vec-store.ts",
		"chroma-vector-store": "src/chroma-vector-store.ts",
		"pgvector-store": "src/pgvector-store.ts",
		"hybrid-search": "src/hybrid-search.ts",
		"lancedb-store": "src/lancedb-store.ts",
		"milvus-store": "src/milvus-store.ts",
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
		"@tauri-apps/api",
		"better-sqlite3",
		"sqlite-vec",
		"@lancedb/lancedb",
		"@zilliz/milvus2-sdk-node",
	],
});
