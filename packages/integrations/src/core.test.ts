import { describe, expect, it } from "vitest";
import {
	createMinimalContext,
	noopAuthProvider,
	noopCloudSyncProvider,
	noopConfigProvider,
	noopCredentialStore,
	noopFileIngester,
	noopSessionStore,
} from "./core/index.js";

describe("createMinimalContext", () => {
	it("returns all six noop providers by default", () => {
		const ctx = createMinimalContext();
		expect(ctx.credentialStore).toBe(noopCredentialStore);
		expect(ctx.authProvider).toBe(noopAuthProvider);
		expect(ctx.sessionStore).toBe(noopSessionStore);
		expect(ctx.fileIngester).toBe(noopFileIngester);
		expect(ctx.configProvider).toBe(noopConfigProvider);
		expect(ctx.cloudSyncProvider).toBe(noopCloudSyncProvider);
	});

	it("allows partial overrides", () => {
		const customAuthProvider = {
			getUserId: () => "user-1",
			getToken: () => "token",
			getLocalUserType: () => "user" as const,
		};
		const ctx = createMinimalContext({ authProvider: customAuthProvider });
		expect(ctx.authProvider).toBe(customAuthProvider);
		expect(ctx.credentialStore).toBe(noopCredentialStore);
		expect(ctx.sessionStore).toBe(noopSessionStore);
		expect(ctx.fileIngester).toBe(noopFileIngester);
		expect(ctx.configProvider).toBe(noopConfigProvider);
		expect(ctx.cloudSyncProvider).toBe(noopCloudSyncProvider);
	});
});

describe("noopCredentialStore", () => {
	it("returns empty arrays and nulls for read operations", async () => {
		await expect(noopCredentialStore.getAccountsByUserId("u1")).resolves.toEqual([]);
		await expect(noopCredentialStore.getAccountByPlatform("u1", "telegram")).resolves.toBeNull();
		await expect(noopCredentialStore.getAccountById("u1", "acc1")).resolves.toBeNull();
	});

	it("updateAccount resolves without doing anything", async () => {
		await expect(
			noopCredentialStore.updateAccount({ userId: "u1", platformAccountId: "acc1" }),
		).resolves.toBeUndefined();
	});

	it("createAccount throws", async () => {
		await expect(noopCredentialStore.createAccount({ userId: "u1", platform: "telegram" })).rejects.toThrow(
			"noopCredentialStore.createAccount not implemented",
		);
	});
});

describe("noopAuthProvider", () => {
	it("returns null for all getters", () => {
		expect(noopAuthProvider.getUserId()).toBeNull();
		expect(noopAuthProvider.getToken()).toBeNull();
		expect(noopAuthProvider.getLocalUserType()).toBeNull();
	});
});

describe("noopSessionStore", () => {
	it("returns null for get and empty array for keys", async () => {
		await expect(noopSessionStore.get("key")).resolves.toBeNull();
		await expect(noopSessionStore.keys("*")).resolves.toEqual([]);
	});

	it("set and del resolve without doing anything", async () => {
		await expect(noopSessionStore.set("key", "value")).resolves.toBeUndefined();
		await expect(noopSessionStore.del("key")).resolves.toBeUndefined();
	});
});

describe("noopFileIngester", () => {
	it("returns failure result for ingestExternal", async () => {
		await expect(
			noopFileIngester.ingestExternal({
				source: "test",
				userId: "u1",
				downloadAttachment: async () => ({ data: new ArrayBuffer(0), sizeBytes: 0 }),
			}),
		).resolves.toEqual({ success: false, reason: "noop" });
	});

	it("returns null for ingestForUser", async () => {
		await expect(
			noopFileIngester.ingestForUser({
				source: "test",
				ownerUserId: "u1",
				downloadAttachment: async () => ({ data: new ArrayBuffer(0), sizeBytes: 0 }),
			}),
		).resolves.toBeNull();
	});

	it("returns empty array for ingestMany", async () => {
		await expect(
			noopFileIngester.ingestMany({
				source: "test",
				ownerUserId: "u1",
				attachments: [],
			}),
		).resolves.toEqual([]);
	});
});

describe("noopConfigProvider", () => {
	it("get returns undefined", () => {
		expect(noopConfigProvider.get("MISSING_KEY")).toBeUndefined();
	});

	it("getRequired throws with the key name", () => {
		expect(() => noopConfigProvider.getRequired("API_KEY")).toThrow('Config key "API_KEY" not configured');
	});
});

describe("noopCloudSyncProvider", () => {
	it("syncAccounts returns 0 and isEnabled returns false", async () => {
		await expect(noopCloudSyncProvider.syncAccounts()).resolves.toBe(0);
		expect(noopCloudSyncProvider.isEnabled()).toBe(false);
	});
});
