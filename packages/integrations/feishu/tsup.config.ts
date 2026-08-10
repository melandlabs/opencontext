import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		"app-registration": "src/app-registration.ts",
		"registration-cookie": "src/registration-cookie.ts",
		"conversation-store": "src/conversation-store.ts",
		state: "src/state.ts",
	},
	format: ["esm"],
	dts: true,
	sourcemap: true,
	clean: true,
	splitting: false,
	treeshake: true,
	external: ["react", "react-dom", "@tauri-apps/api", "better-sqlite3", "sqlite-vec"],
});
