import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		"user-type": "src/user-type.ts",
		"integration-id": "src/integration-id.ts",
		errors: "src/errors.ts",
		schemas: "src/schemas.ts",
	},
	format: ["esm"],
	dts: true,
	sourcemap: true,
	clean: true,
	splitting: false,
	treeshake: true,
	external: ["zod"],
});
