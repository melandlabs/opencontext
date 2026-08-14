import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		"conversation-store": "src/conversation-store.ts",
		index: "src/conversation-store.ts",
	},
	format: ["esm"],
	dts: true,
	sourcemap: false,
	clean: true,
	splitting: false,
	treeshake: true,
	external: ["react", "react-dom", "@tauri-apps/api", "better-sqlite3", "sqlite-vec"],
});
