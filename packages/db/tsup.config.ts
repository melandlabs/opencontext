import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		batch: "src/batch.ts",
		utils: "src/utils.ts",
		"agent-goal-runtime-schema-types": "src/agent-goal-runtime-schema-types.ts",
	},
	format: ["esm"],
	dts: true,
	sourcemap: true,
	clean: true,
	splitting: false,
	treeshake: true,
});
