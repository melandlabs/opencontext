import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    types: "src/types.ts",
    "memory/index": "src/memory/index.ts",
    "store/index": "src/store/index.ts",
    "audio/index": "src/audio/index.ts",
    "agent/index": "src/agent/index.ts",
    "agent/native-cli/index": "src/agent/native-cli/index.ts",
    "agent/native-runner/index": "src/agent/native-runner/index.ts",
    "agent/runtime/index": "src/agent/runtime/index.ts",
    "agent/supplemental-input/index": "src/agent/supplemental-input/index.ts",
    "agent/runtime-instructions/index":
      "src/agent/runtime-instructions/index.ts",
    "agent/image-gen/index": "src/agent/image-gen/index.ts",
    "agent/sandbox/index": "src/agent/sandbox/index.ts",
    "agent/sandbox/types": "src/agent/sandbox/types.ts",
    "agent/sandbox/plugin": "src/agent/sandbox/plugin.ts",
    "agent/sandbox/registry": "src/agent/sandbox/registry.ts",
    "agent/sandbox/providers/native": "src/agent/sandbox/providers/native.ts",
    "agent/sandbox/providers/claude": "src/agent/sandbox/providers/claude.ts",
    "agent/sandbox/providers/vercel": "src/agent/sandbox/providers/vercel.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  external: [
    "react",
    "react-dom",
    "@tauri-apps/api",
    "better-sqlite3",
    "sqlite-vec",
  ],
});
