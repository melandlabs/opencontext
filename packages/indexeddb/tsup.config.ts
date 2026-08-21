import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		extractor: "src/extractor.ts",
		grouping: "src/grouping.ts",
		client: "src/client.ts",
	},
	format: ["esm"],
	dts: true,
	sourcemap: false,
	clean: true,
	splitting: false,
	treeshake: true,
	external: ["react", "react-dom", "@tauri-apps/api", "better-sqlite3", "sqlite-vec"],
});
