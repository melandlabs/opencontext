import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "platform/env": "src/platform/env.ts",
    "platform/filesystem": "src/platform/filesystem.ts",
    "platform/adapters/tauri/filesystem": "src/platform/adapters/tauri/filesystem.ts",
    "platform/adapters/browser/filesystem": "src/platform/adapters/browser/filesystem.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  external: ["react", "react-dom", "@tauri-apps/api"],
});