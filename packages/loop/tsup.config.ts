import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    paths: "src/paths.ts",
    "cli-path": "src/cli-path.ts",
    preferences: "src/preferences.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
});
