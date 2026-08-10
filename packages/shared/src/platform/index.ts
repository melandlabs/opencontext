// Phase 8: Platform detection moved to @opencontext/ui-runtime.
// shared no longer statically depends on the tauri runtime.
export {
  getFileSystem,
  type PlatformFileSystem,
  type SaveFileOptions,
  type DirEntry,
  type ListDirectoryOptions,
} from "@opencontext/ui-runtime/platform/filesystem";

export {
  isClient,
  isTauri,
  isBrowser,
  getPlatformKind,
} from "@opencontext/ui-runtime/platform/env";