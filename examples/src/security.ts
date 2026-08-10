/**
 * @melandlabs/security smoke test.
 *
 * Token encryption, SSRF-safe URL validation, and the key manager. We
 * exercise the pure URL validator (which doesn't need a key) and verify
 * the crypto helpers exist as classes/functions.
 */

import {
	KeyManager,
	TokenEncryption,
	isTrustedStorageUrl,
	validateUrlForSSRF,
} from "@melandlabs/security";
import { makeCheck, runSection } from "./_helpers.ts";

export default async function testSecurity() {
	await runSection("@melandlabs/security", async () => {
		const check = makeCheck("security");
		check("TokenEncryption is a class", typeof TokenEncryption === "function");
		check("KeyManager is a class", typeof KeyManager === "function");
		check(
			"isTrustedStorageUrl is a function",
			typeof isTrustedStorageUrl === "function",
		);
		check(
			"validateUrlForSSRF is a function",
			typeof validateUrlForSSRF === "function",
		);

		// Pure checks — these don't touch network.
		try {
			await validateUrlForSSRF("http://example.com/");
			check("validateUrlForSSRF throws for http://", false);
		} catch {
			check("validateUrlForSSRF throws for http://", true);
		}
	});
}
