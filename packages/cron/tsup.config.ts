import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		types: "src/types.ts",
		scheduler: "src/scheduler.ts",
		"stream-response": "src/stream-response.ts",
	},
	format: ["esm"],
	dts: true,
	sourcemap: false,
	clean: true,
	splitting: false,
	treeshake: true,
});
