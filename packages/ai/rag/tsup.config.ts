import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		chunking: "src/chunking.ts",
		embeddings: "src/embeddings.ts",
		"vector-service": "src/vector-service.ts",
		"unified-vector-search-service": "src/unified-vector-search-service.ts",
		parsers: "src/parsers.ts",
		"embedding-provider": "src/embedding-provider.ts",
		"local-transformers-embedding-provider": "src/local-transformers-embedding-provider.ts",
		"universal-embeddings": "src/universal-embeddings.ts",
		"chroma-store": "src/chroma-store.ts",
		"sqlite-vec-store": "src/sqlite-vec-store.ts",
		"pgvector-store": "src/pgvector-store.ts",
	},
	format: ["esm"],
	dts: true,
	sourcemap: false,
	clean: true,
	splitting: false,
	treeshake: true,
	external: ["react", "react-dom", "@tauri-apps/api", "better-sqlite3", "sqlite-vec"],
});
