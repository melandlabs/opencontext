import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

describe("env-config", () => {
	afterEach(() => {
		// Restore process.env
		process.env = { ...originalEnv };

		// Restore process.platform
		if (originalPlatform) {
			Object.defineProperty(process, "platform", originalPlatform);
		}

		// Restore globals
		vi.unstubAllGlobals();

		// Clear module cache so re-imports pick up fresh env/platform values
		vi.resetModules();
	});

	describe("client-constants", () => {
		it("detects Tauri mode from TAURI_MODE", async () => {
			process.env.TAURI_MODE = "1";
			const { isTauriMode, isServerMode } = await import("./client-constants");
			expect(isTauriMode()).toBe(true);
			expect(isServerMode()).toBe(false);
		});

		it("detects Tauri mode from IS_TAURI=true", async () => {
			process.env.IS_TAURI = "true";
			const { isTauriMode, isServerMode } = await import("./client-constants");
			expect(isTauriMode()).toBe(true);
			expect(isServerMode()).toBe(false);
		});

		it("defaults to server mode when no Tauri env is set", async () => {
			process.env.TAURI_MODE = undefined;
			process.env.IS_TAURI = undefined;
			const { isTauriMode, isServerMode } = await import("./client-constants");
			expect(isTauriMode()).toBe(false);
			expect(isServerMode()).toBe(true);
		});

		it("reports production environment", async () => {
			process.env.NODE_ENV = "production";
			const { isProductionEnvironment, isDevelopmentEnvironment, isTestEnvironment } = await import(
				"./client-constants"
			);
			expect(isProductionEnvironment).toBe(true);
			expect(isDevelopmentEnvironment).toBe(false);
			expect(isTestEnvironment).toBe(false);
		});

		it("reports development environment", async () => {
			process.env.NODE_ENV = "development";
			const { isProductionEnvironment, isDevelopmentEnvironment, isTestEnvironment } = await import(
				"./client-constants"
			);
			expect(isProductionEnvironment).toBe(false);
			expect(isDevelopmentEnvironment).toBe(true);
			expect(isTestEnvironment).toBe(false);
		});

		it("reports test environment from Playwright/CI flags", async () => {
			process.env.NODE_ENV = "development";
			process.env.PLAYWRIGHT_TEST_BASE_URL = "http://localhost:3000";
			const { isTestEnvironment } = await import("./client-constants");
			expect(isTestEnvironment).toBe(true);

			process.env.PLAYWRIGHT_TEST_BASE_URL = undefined;
			process.env.PLAYWRIGHT = "1";
			const { isTestEnvironment: isTestEnvironment2 } = await import("./client-constants");
			expect(isTestEnvironment2).toBe(true);

			process.env.PLAYWRIGHT = undefined;
			process.env.CI_PLAYWRIGHT = "1";
			const { isTestEnvironment: isTestEnvironment3 } = await import("./client-constants");
			expect(isTestEnvironment3).toBe(true);
		});

		it("exports expected constants", async () => {
			process.env.NEXT_PUBLIC_ANTHROPIC_MODEL = "claude-test";
			process.env.NEXT_PUBLIC_AI_PROXY_URL = "/api/test";
			process.env.NEXT_PUBLIC_FF_SCREEN_MEMORY = "1";

			const { guestRegex, DEFAULT_AI_MODEL, AI_PROXY_BASE_URL, APP_DIR_NAME, FF_SCREEN_MEMORY } =
				await import("./client-constants");

			expect(guestRegex.test("guest-42")).toBe(true);
			expect(guestRegex.test("not-a-guest")).toBe(false);
			expect(DEFAULT_AI_MODEL).toBe("claude-test");
			expect(AI_PROXY_BASE_URL).toBe("/api/test");
			expect(APP_DIR_NAME).toBe(".opencontext");
			expect(FF_SCREEN_MEMORY).toBe(true);
		});

		it("falls back to default constants when env vars are absent", async () => {
			process.env.NEXT_PUBLIC_ANTHROPIC_MODEL = undefined;
			process.env.NEXT_PUBLIC_AI_PROXY_URL = undefined;
			process.env.NEXT_PUBLIC_FF_SCREEN_MEMORY = undefined;

			const { DEFAULT_AI_MODEL, AI_PROXY_BASE_URL, FF_SCREEN_MEMORY } = await import("./client-constants");

			expect(DEFAULT_AI_MODEL).toBe("claude-sonnet-5");
			expect(AI_PROXY_BASE_URL).toBe("/api/ai");
			expect(FF_SCREEN_MEMORY).toBe(false);
		});
	});

	describe("client-mode", () => {
		it("detects Tauri mode from window.__TAURI__", async () => {
			vi.stubGlobal("window", { __TAURI__: {} });
			const { isTauriMode, isServerMode } = await import("./client-mode");
			expect(isTauriMode()).toBe(true);
			expect(isServerMode()).toBe(false);
		});

		it("detects Tauri mode from process.env.TAURI_MODE", async () => {
			process.env.TAURI_MODE = "1";
			const { isTauriMode, isServerMode } = await import("./client-mode");
			expect(isTauriMode()).toBe(true);
			expect(isServerMode()).toBe(false);
		});

		it("detects Tauri mode from process.env.IS_TAURI", async () => {
			process.env.IS_TAURI = "true";
			const { isTauriMode, isServerMode } = await import("./client-mode");
			expect(isTauriMode()).toBe(true);
			expect(isServerMode()).toBe(false);
		});

		it("defaults to server mode when neither window nor env indicate Tauri", async () => {
			process.env.TAURI_MODE = undefined;
			process.env.IS_TAURI = undefined;
			const { isTauriMode, isServerMode } = await import("./client-mode");
			expect(isTauriMode()).toBe(false);
			expect(isServerMode()).toBe(true);
		});
	});

	describe("tauri-paths", () => {
		beforeEach(() => {
			process.env.TAURI_DATA_DIR = undefined;
			process.env.TAURI_DB_PATH = undefined;
			process.env.TAURI_STORAGE_PATH = undefined;
			process.env.TAURI_LOGS_PATH = undefined;
		});

		it("uses TAURI_DATA_DIR override when set", async () => {
			process.env.TAURI_DATA_DIR = "/custom/data";
			const { getTauriDataDir, getTauriDbPath, getTauriStoragePath, getTauriLogsPath } = await import(
				"./tauri-paths"
			);
			expect(getTauriDataDir()).toBe("/custom/data");
			expect(getTauriDbPath()).toBe("/custom/data/data.db");
			expect(getTauriStoragePath()).toBe("/custom/data/storage");
			expect(getTauriLogsPath()).toBe("/custom/data/logs");
		});

		it("uses TAURI_DB_PATH override when set", async () => {
			process.env.TAURI_DB_PATH = "/custom/db.sqlite";
			const { getTauriDbPath } = await import("./tauri-paths");
			expect(getTauriDbPath()).toBe("/custom/db.sqlite");
		});

		it("uses development Windows path when platform is win32", async () => {
			process.env.NODE_ENV = "development";
			Object.defineProperty(process, "platform", { value: "win32" });
			process.env.APPDATA = "C:\\Users\\Tester\\AppData\\Roaming";

			const { getTauriDataDir } = await import("./tauri-paths");
			expect(getTauriDataDir()).toBe("C:\\Users\\Tester\\AppData\\Roaming/opencontext");
		});

		it("uses development macOS path when platform is darwin", async () => {
			process.env.NODE_ENV = "development";
			Object.defineProperty(process, "platform", { value: "darwin" });
			process.env.HOME = "/Users/tester";

			const { getTauriDataDir } = await import("./tauri-paths");
			expect(getTauriDataDir()).toBe("/Users/tester/Library/Application Support/opencontext");
		});

		it("uses development Linux path for non-darwin Unix platforms", async () => {
			process.env.NODE_ENV = "development";
			Object.defineProperty(process, "platform", { value: "linux" });
			process.env.HOME = "/home/tester";

			const { getTauriDataDir } = await import("./tauri-paths");
			expect(getTauriDataDir()).toBe("/home/tester/.config/opencontext");
		});

		it("uses production Windows path with USERPROFILE when available", async () => {
			process.env.NODE_ENV = "production";
			Object.defineProperty(process, "platform", { value: "win32" });
			process.env.USERPROFILE = "C:\\Users\\Tester";

			const { getTauriDataDir } = await import("./tauri-paths");
			expect(getTauriDataDir()).toBe(join("C:\\Users\\Tester", ".opencontext", "data"));
		});

		it("falls back to APPDATA when USERPROFILE is unavailable on Windows", async () => {
			process.env.NODE_ENV = "production";
			Object.defineProperty(process, "platform", { value: "win32" });
			process.env.USERPROFILE = undefined;
			process.env.APPDATA = "C:\\Users\\Tester\\AppData\\Roaming";

			const { getTauriDataDir } = await import("./tauri-paths");
			expect(getTauriDataDir()).toBe(join("C:\\Users\\Tester\\AppData\\Roaming", "opencontext", "data"));
		});

		it("uses production Unix path", async () => {
			process.env.NODE_ENV = "production";
			Object.defineProperty(process, "platform", { value: "linux" });
			process.env.HOME = "/home/tester";

			const { getTauriDataDir, getTauriDbPath, getTauriStoragePath, getTauriLogsPath } = await import(
				"./tauri-paths"
			);
			const dataDir = getTauriDataDir();
			expect(dataDir).toMatch(/\.opencontext\/data$/);
			expect(getTauriDbPath()).toBe(`${dataDir}/data.db`);
			expect(getTauriStoragePath()).toBe(`${dataDir}/storage`);
			expect(getTauriLogsPath()).toBe(`${dataDir}/logs`);
		});
	});
});
