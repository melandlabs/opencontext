import { isTauri as tauriIsTauri } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPlatformKind, isBrowser, isClient, isTauri } from "./env";

vi.mock("@tauri-apps/api/core", () => ({
	isTauri: vi.fn(),
}));

describe("env platform helpers", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		(globalThis as unknown as { window?: unknown }).window = undefined;
	});

	describe("isClient", () => {
		it("returns true when globalThis.window is defined", () => {
			(globalThis as unknown as { window?: unknown }).window = {};
			expect(isClient()).toBe(true);
		});

		it("returns false when globalThis.window is undefined", () => {
			expect(isClient()).toBe(false);
		});
	});

	describe("isTauri", () => {
		it("returns false when not client", () => {
			vi.mocked(tauriIsTauri).mockReturnValue(true);
			expect(isTauri()).toBe(false);
			expect(tauriIsTauri).not.toHaveBeenCalled();
		});

		it("returns true when client and @tauri-apps/api/core.isTauri returns true", () => {
			(globalThis as unknown as { window?: unknown }).window = {};
			vi.mocked(tauriIsTauri).mockReturnValue(true);
			expect(isTauri()).toBe(true);
			expect(tauriIsTauri).toHaveBeenCalledTimes(1);
		});

		it("returns false when client and @tauri-apps/api/core.isTauri returns false", () => {
			(globalThis as unknown as { window?: unknown }).window = {};
			vi.mocked(tauriIsTauri).mockReturnValue(false);
			expect(isTauri()).toBe(false);
		});

		it("returns false when client and @tauri-apps/api/core.isTauri throws", () => {
			(globalThis as unknown as { window?: unknown }).window = {};
			vi.mocked(tauriIsTauri).mockImplementation(() => {
				throw new Error("tauri not available");
			});
			expect(isTauri()).toBe(false);
		});
	});

	describe("isBrowser", () => {
		it("returns false when not client", () => {
			vi.mocked(tauriIsTauri).mockReturnValue(false);
			expect(isBrowser()).toBe(false);
		});

		it("returns false when client but running in Tauri", () => {
			(globalThis as unknown as { window?: unknown }).window = {};
			vi.mocked(tauriIsTauri).mockReturnValue(true);
			expect(isBrowser()).toBe(false);
		});

		it("returns true when client and not running in Tauri", () => {
			(globalThis as unknown as { window?: unknown }).window = {};
			vi.mocked(tauriIsTauri).mockReturnValue(false);
			expect(isBrowser()).toBe(true);
		});
	});

	describe("getPlatformKind", () => {
		it("returns 'browser' when not client", () => {
			vi.mocked(tauriIsTauri).mockReturnValue(false);
			expect(getPlatformKind()).toBe("browser");
		});

		it("returns 'tauri' when client and in Tauri", () => {
			(globalThis as unknown as { window?: unknown }).window = {};
			vi.mocked(tauriIsTauri).mockReturnValue(true);
			expect(getPlatformKind()).toBe("tauri");
		});

		it("returns 'browser' when client but not in Tauri", () => {
			(globalThis as unknown as { window?: unknown }).window = {};
			vi.mocked(tauriIsTauri).mockReturnValue(false);
			expect(getPlatformKind()).toBe("browser");
		});
	});
});
