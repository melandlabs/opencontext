import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		"user-type": "src/user-type.ts",
		"integration-id": "src/integration-id.ts",
		"entity-type": "src/entity-type.ts",
		episode: "src/episode.ts",
		decision: "src/decision.ts",
		errors: "src/errors.ts",
		peer: "src/peer.ts",
		"fact-type": "src/fact-type.ts",
		"vsa-fact": "src/vsa-fact.ts",
		schemas: "src/schemas.ts",
	},
	format: ["esm"],
	dts: true,
	sourcemap: false,
	clean: true,
	splitting: false,
	treeshake: true,
	external: ["zod"],
});
