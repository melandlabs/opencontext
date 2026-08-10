import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		adapter: "src/adapter.ts",
		markdown: "src/markdown.ts",
		"conversation-store": "src/conversation-store.ts",
		state: "src/state.ts",
		"tdata-decrypter-index": "src/tdata-decrypter/index.ts",
		"tdata-converter": "src/tdata-converter.ts",
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
