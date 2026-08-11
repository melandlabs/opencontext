/**
 * demo: @melandlabs/security — token encryption and SSRF validation.
 *
 * Two independent concerns live here.
 *
 * `TokenEncryption` encrypts OAuth tokens at rest using Fernet
 * (AES-128-CBC + HMAC-SHA256, with a timestamp for TTL enforcement).
 * The key comes from the `ENCRYPTION_KEY` environment variable: a
 * 32-character value is used directly, anything else is stretched with
 * PBKDF2-SHA256 (100k iterations). This demo generates a throwaway key
 * so it never reads or depends on your real one.
 *
 * `validateUrlForSSRF` guards every outbound fetch built from
 * user-supplied input. It is deny-by-default: HTTPS only, host must be
 * on the allow-list, and private / link-local addresses are rejected —
 * which is what stops a "fetch this URL for me" feature from being
 * turned into a probe of your cloud metadata endpoint.
 */

import crypto from "node:crypto";
import { info, makeCheck, runSection } from "../_helpers.ts";

export default async function demoSecurity() {
	await runSection("demo: @melandlabs/security", async () => {
		const check = makeCheck("demo/security");

		// Use a throwaway key for the duration of this demo, then restore
		// whatever was there before.
		const previousKey = process.env.ENCRYPTION_KEY;
		process.env.ENCRYPTION_KEY = crypto.randomBytes(24).toString("base64"); // 32 chars

		try {
			const { TokenEncryption, isTrustedStorageUrl, validateUrlForSSRF } = await import("@melandlabs/security");

			// ── Token encryption ──────────────────────────────────────────
			const enc = new TokenEncryption();
			const secret = "ya29.a0AfB_bytes-that-look-like-an-oauth-token";

			const ciphertext = enc.encryptToken(secret);
			const roundTripped = enc.decryptToken(ciphertext);

			info("demo/security", `plaintext ${secret.length} chars → ciphertext ${ciphertext.length} chars`);
			info("demo/security", `ciphertext begins with ${ciphertext.slice(0, 12)}… (Fernet v0x80 prefix)`);

			check("decryptToken recovers the exact plaintext", roundTripped === secret);
			check("the ciphertext does not contain the plaintext", !ciphertext.includes(secret));
			check("the ciphertext is a Fernet token (gAAAAA… prefix)", ciphertext.startsWith("gAAAAA"));

			// Fernet embeds a random IV, so encrypting twice gives different
			// bytes — an attacker can't tell that two users stored the same
			// token.
			const second = enc.encryptToken(secret);
			info("demo/security", "encrypting the same plaintext twice produces different ciphertexts");
			check("encryption is non-deterministic (fresh IV each time)", second !== ciphertext);
			check("both ciphertexts still decrypt to the same plaintext", enc.decryptToken(second) === secret);

			// A different key cannot read the first key's ciphertext.
			process.env.ENCRYPTION_KEY = crypto.randomBytes(24).toString("base64");
			let wrongKeyRejected = false;
			try {
				new TokenEncryption().decryptToken(ciphertext);
			} catch {
				wrongKeyRejected = true;
			}
			check("a token encrypted under one key cannot be decrypted with another", wrongKeyRejected);

			// ── SSRF validation ───────────────────────────────────────────
			const cases: Array<[string, string]> = [
				["http://example.com/", "plain HTTP"],
				["https://example.com/", "HTTPS but not on the allow-list"],
				["https://127.0.0.1/admin", "loopback address"],
				["https://169.254.169.254/latest/meta-data/", "cloud metadata endpoint"],
				["https://10.0.0.5/internal", "private RFC1918 address"],
			];

			const blocked: string[] = [];
			for (const [url, why] of cases) {
				try {
					await validateUrlForSSRF(url);
				} catch (err) {
					blocked.push(url);
					info("demo/security", `blocked ${why}: ${(err as Error).message}`);
				}
			}
			check(
				"every unsafe URL above is rejected",
				blocked.length === cases.length,
				`${blocked.length}/${cases.length} blocked`,
			);

			check(
				"isTrustedStorageUrl accepts a known storage host",
				isTrustedStorageUrl("https://x.public.blob.vercel-storage.com/file.png") === true,
			);
			check(
				"isTrustedStorageUrl rejects an arbitrary host",
				isTrustedStorageUrl("https://evil.example.com/file.png") === false,
			);
		} finally {
			if (previousKey === undefined) delete process.env.ENCRYPTION_KEY;
			else process.env.ENCRYPTION_KEY = previousKey;
		}
	});
}
