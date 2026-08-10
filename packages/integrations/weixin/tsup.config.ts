import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "ws-listener": "src/ws-listener.ts",
    "conversation-store": "src/conversation-store.ts",
    "ilink-client": "src/ilink-client.ts",
    "cdn-aes-ecb": "src/cdn/aes-ecb.ts",
    "cdn-cdn-upload": "src/cdn/cdn-upload.ts",
    "cdn-cdn-url": "src/cdn/cdn-url.ts",
    "cdn-pic-decrypt": "src/cdn/pic-decrypt.ts",
    "qr-login": "src/qr-login.ts",
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
