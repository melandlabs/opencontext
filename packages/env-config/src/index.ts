// client-mode.ts and client-constants.ts both define isTauriMode/isServerMode.
// client-constants.ts is the canonical source (matches the runtime
// DEPLOYMENT_MODE constant). client-mode.ts is preserved as a subpath for
// callers that want the more thorough window.__TAURI__ runtime check.
export * from "./client-constants";
export * from "./tauri-paths";