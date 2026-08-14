import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		"authorization-errors": "src/authorization-errors.ts",
		"platform-visuals": "src/platform-visuals.ts",
		"platform-connectability": "src/platform-connectability.ts",
		"task-integration-inference": "src/task-integration-inference.ts",
		"oauth-callback-script": "src/oauth-callback-script.ts",
	},
	format: ["esm"],
	dts: true,
	sourcemap: false,
	clean: true,
	splitting: false,
	treeshake: true,
});
