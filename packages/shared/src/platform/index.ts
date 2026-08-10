// Platform detection lives in @melandlabs/ui-runtime. shared no longer
// statically depends on the Tauri runtime.
export {
	getFileSystem,
	type PlatformFileSystem,
	type SaveFileOptions,
	type DirEntry,
	type ListDirectoryOptions,
} from "@melandlabs/ui-runtime/platform/filesystem";

export {
	isClient,
	isTauri,
	isBrowser,
	getPlatformKind,
} from "@melandlabs/ui-runtime/platform/env";
