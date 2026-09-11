import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		errors: "src/errors.ts",
		ref: "src/ref.ts",
		soul: "src/soul.ts",
		"text-chunking": "src/text-chunking.ts",
		utils: "src/utils.ts",
	},
	format: ["esm"],
	dts: true,
	sourcemap: false,
	clean: true,
	splitting: false,
	treeshake: true,
	external: ["react", "react-dom", "@tauri-apps/api", "better-sqlite3", "sqlite-vec"],
});
