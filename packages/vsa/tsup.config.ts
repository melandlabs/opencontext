import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		hrr: "src/hrr.ts",
		facts: "src/facts.ts",
		types: "src/types.ts",
	},
	format: ["esm"],
	dts: true,
	sourcemap: false,
	clean: true,
	splitting: false,
	treeshake: true,
});
