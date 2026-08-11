/**
 * demo: @melandlabs/ui-runtime — platform detection.
 *
 * Shared UI code runs in three places: a Tauri desktop webview, a plain
 * browser tab, and Node (SSR, scripts, tests). These predicates are how a
 * component decides whether it may touch `window`, or whether it should
 * use the native filesystem bridge instead of the browser one.
 *
 * This demo runs under Node, so every predicate should report "not a
 * browser, not Tauri" — which is exactly the case SSR code must handle.
 */

import { getPlatformKind, isBrowser, isClient, isTauri } from "@melandlabs/ui-runtime";
import { info, makeCheck, runSection } from "./_helpers.ts";

export default async function demoUiRuntime() {
	await runSection("demo: @melandlabs/ui-runtime", async () => {
		const check = makeCheck("demo/ui-runtime");

		const tauri = isTauri();
		const client = isClient();
		const browser = isBrowser();
		const kind = getPlatformKind();

		info("demo/ui-runtime", `isTauri()=${tauri}, isClient()=${client}, isBrowser()=${browser}`);

		check("isTauri() is false under plain Node", tauri === false);
		check("isBrowser() is false under plain Node — there is no window", browser === false);
		check("isClient() is false under plain Node", client === false);
		check("isBrowser() is defined as 'a client that isn't Tauri'", browser === (client && !tauri));
		check("Tauri implies client: a Tauri webview is never detected without a window", !tauri || client);

		// getPlatformKind() only distinguishes tauri from browser — there is
		// no "server" member — so on Node it falls through to "browser" even
		// though isBrowser() is false. Branch on isClient() first if you need
		// to tell SSR apart from a real browser.
		info("demo/ui-runtime", `getPlatformKind() = ${JSON.stringify(kind)} (note: no "server" kind exists)`);
		check("getPlatformKind() names the host", kind === "tauri" || kind === "browser", String(kind));
		check("getPlatformKind() agrees with isTauri()", (kind === "tauri") === tauri);
		check("no predicate threw on a `window`-less host", true);
	});
}
