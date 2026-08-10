import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		local: "src/local.ts",
		provider: "src/provider.ts",
		memory: "src/memory.ts",
		"adapters-index": "src/adapters/index.ts",
		"adapters-local-fs": "src/adapters/local-fs.ts",
		"adapters-vercel-blob": "src/adapters/vercel-blob.ts",
		index: "src/local.ts",
	},
	format: ["esm"],
	dts: true,
	sourcemap: true,
	clean: true,
	splitting: false,
	treeshake: true,
	external: [
		"react",
		"react-dom",
		"@tauri-apps/api",
		"better-sqlite3",
		"sqlite-vec",
	],
});
