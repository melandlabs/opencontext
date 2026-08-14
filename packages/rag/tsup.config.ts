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
