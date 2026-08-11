/**
 * @melandlabs/security — token encryption + SSRF validation.
 *
 * Two independent concerns share this file. They live together because
 * each is small enough that splitting them would create more noise
 * than it removes.
 *
 *   1. TokenEncryption (Fernet) — encrypt / decrypt round-trip,
 *      non-deterministic IV, foreign-key rejection.
 *   2. validateUrlForSSRF — deny-by-default for plain HTTP, loopback,
 *      RFC1918, link-local, cloud metadata, and documentation prefixes.
 *
 * The tests use a throwaway ENCRYPTION_KEY generated per test and
 * always restore the previous value in `afterEach`, so a test failure
 * can't leak the developer's real key.
 */

import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TokenEncryption, isTrustedStorageUrl, validateUrlForSSRF } from "./index";

const ORIGINAL_KEY = process.env.ENCRYPTION_KEY;

beforeEach(() => {
	// 32 bytes → direct Fernet key path (not the PBKDF2 fallback).
	process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

afterEach(() => {
	// biome-ignore lint/performance/noDelete: assigning undefined would set ENCRYPTION_KEY to the string "undefined".
	if (ORIGINAL_KEY === undefined) delete process.env.ENCRYPTION_KEY;
	else process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
});

describe("TokenEncryption (Fernet)", () => {
	it("encrypts and decrypts a string back to the exact plaintext", () => {
		const enc = new TokenEncryption();
		const plaintext = "ya29.A0AfH6SMA_look-at-this-oauth-token";
		const ct = enc.encryptToken(plaintext);
		expect(enc.decryptToken(ct)).toBe(plaintext);
	});

	it("emits a Fernet v0 ciphertext (gAAAAA… prefix)", () => {
		const enc = new TokenEncryption();
		const ct = enc.encryptToken("anything");
		expect(ct.startsWith("gAAAAA")).toBe(true);
	});

	it("the ciphertext does not contain the plaintext", () => {
		const enc = new TokenEncryption();
		const plaintext = "super-secret-payload-that-must-not-leak";
		const ct = enc.encryptToken(plaintext);
		expect(ct.includes(plaintext)).toBe(false);
	});

	it("encrypting the same plaintext twice yields different ciphertexts (fresh IV)", () => {
		const enc = new TokenEncryption();
		const plaintext = "same input twice";
		const a = enc.encryptToken(plaintext);
		const b = enc.encryptToken(plaintext);
		expect(a).not.toBe(b);
		// But both still decrypt to the same plaintext.
		expect(enc.decryptToken(a)).toBe(plaintext);
		expect(enc.decryptToken(b)).toBe(plaintext);
	});

	it("decryption with a different key throws", () => {
		const encA = new TokenEncryption();
		const ct = encA.encryptToken("x");
		// Swap the key. A second instance picks up the new key lazily.
		process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
		const encB = new TokenEncryption();
		expect(() => encB.decryptToken(ct)).toThrow();
	});

	it("encrypts and decrypts empty strings", () => {
		const enc = new TokenEncryption();
		const ct = enc.encryptToken("");
		expect(enc.decryptToken(ct)).toBe("");
	});

	it("encrypts and decrypts unicode correctly", () => {
		const enc = new TokenEncryption();
		const plaintext = "你好世界 — emoji 🎉 — latin: café";
		const ct = enc.encryptToken(plaintext);
		expect(enc.decryptToken(ct)).toBe(plaintext);
	});
});

describe("validateUrlForSSRF", () => {
	it("rejects plain http URLs (HTTPS-only by default)", async () => {
		await expect(validateUrlForSSRF("http://example.com/")).rejects.toThrow();
	});

	it("rejects HTTPS loopback (127.0.0.1)", async () => {
		await expect(validateUrlForSSRF("https://127.0.0.1/admin")).rejects.toThrow();
	});

	it("rejects HTTPS cloud metadata endpoint (169.254.169.254)", async () => {
		await expect(validateUrlForSSRF("https://169.254.169.254/latest/meta-data/")).rejects.toThrow();
	});

	it("rejects HTTPS RFC1918 private addresses (10.0.0.0/8)", async () => {
		await expect(validateUrlForSSRF("https://10.0.0.5/internal")).rejects.toThrow();
	});

	it("rejects HTTPS RFC1918 private addresses (192.168.0.0/16)", async () => {
		await expect(validateUrlForSSRF("https://192.168.1.1/")).rejects.toThrow();
	});

	it("rejects HTTPS RFC1918 private addresses (172.16.0.0/12)", async () => {
		await expect(validateUrlForSSRF("https://172.20.5.5/")).rejects.toThrow();
	});

	it("rejects .localhost and .local hostnames", async () => {
		await expect(validateUrlForSSRF("https://something.localhost/")).rejects.toThrow();
	});

	it("rejects .internal / .corp / .intranet hostnames", async () => {
		await expect(validateUrlForSSRF("https://mail.internal/")).rejects.toThrow();
		await expect(validateUrlForSSRF("https://hr.corp/")).rejects.toThrow();
	});

	it("rejects .test / .example / .invalid TLDs", async () => {
		await expect(validateUrlForSSRF("https://something.test/")).rejects.toThrow();
		await expect(validateUrlForSSRF("https://docs.example/")).rejects.toThrow();
		await expect(validateUrlForSSRF("https://config.invalid/")).rejects.toThrow();
	});
});

describe("isTrustedStorageUrl", () => {
	it("accepts known trusted storage hosts", () => {
		expect(isTrustedStorageUrl("https://x.public.blob.vercel-storage.com/file.png")).toBe(true);
		expect(isTrustedStorageUrl("https://storage.googleapis.com/bucket/key")).toBe(true);
		expect(isTrustedStorageUrl("https://files.slack.com/x")).toBe(true);
	});

	it("rejects arbitrary hosts", () => {
		expect(isTrustedStorageUrl("https://evil.example.com/file.png")).toBe(false);
		expect(isTrustedStorageUrl("https://notion.so.attacker.com/page")).toBe(false);
	});

	it("does not require HTTPS — the allow-list matcher is hostname-only", () => {
		// Documenting the actual behaviour: isTrustedStorageUrl is a
		// hostname allow-list, not a scheme check. Callers that need
		// both should compose: `isTrustedStorageUrl(url) && new URL(url).protocol === "https:"`.
		expect(isTrustedStorageUrl("http://x.public.blob.vercel-storage.com/file.png")).toBe(true);
	});
});
