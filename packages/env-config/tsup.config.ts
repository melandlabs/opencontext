import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "client-constants": "src/client-constants.ts",
    "client-mode": "src/client-mode.ts",
    "tauri-paths": "src/tauri-paths.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  external: ["react", "react-dom"],
});