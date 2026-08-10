// NOTE: @opencontext/ui-runtime is a UI-side package that ships
// Tauri platform detection + browser/Tauri filesystem adapters.
// Its Tauri dependencies (@tauri-apps/api, plugin-dialog, plugin-fs)
// are declared as optional peers so that this package can still be
// type-checked and built in environments without Tauri (e.g. the
// opencontext CI matrix). Host applications that embed opencontext
// inside a Tauri runtime must install the relevant @tauri-apps
// plugins at the application level.

export * from "./platform";