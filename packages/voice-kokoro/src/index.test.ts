import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KokoroPlugin } from "./index";

describe("KokoroPlugin", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
		warnSpy.mockRestore();
	});

	it("initializes with default state", () => {
		const plugin = new KokoroPlugin();

		expect(plugin.enabled).toBe(true);
		expect(plugin.voice).toBe("af_bella");
	});

	it("applies constructor options", () => {
		const plugin = new KokoroPlugin({ enabled: false, voice: "am_michael" });

		expect(plugin.enabled).toBe(false);
		expect(plugin.voice).toBe("am_michael");
	});

	it("does not throw when constructed in Node", () => {
		expect(() => new KokoroPlugin()).not.toThrow();
	});

	it("stop() is callable and resets internal state", () => {
		const plugin = new KokoroPlugin();

		expect(() => plugin.stop()).not.toThrow();
		expect(() => plugin.stop()).not.toThrow();

		const internal = plugin as unknown as {
			currentRequestController: AbortController | null;
			currentWarmupController: AbortController | null;
			currentAudio: unknown;
			currentObjectUrl: string | null;
			currentPlaybackAbort: (() => void) | null;
			hasWarmedUp: boolean;
			warmupPromise: Promise<void> | null;
			speechRunId: number;
		};

		expect(internal.currentRequestController).toBeNull();
		expect(internal.currentWarmupController).toBeNull();
		expect(internal.currentAudio).toBeNull();
		expect(internal.currentObjectUrl).toBeNull();
		expect(internal.currentPlaybackAbort).toBeNull();
		expect(internal.hasWarmedUp).toBe(false);
		expect(internal.warmupPromise).toBeNull();
		expect(internal.speechRunId).toBe(2);
	});

	it("warmup() returns immediately in Node", async () => {
		const plugin = new KokoroPlugin();

		await expect(plugin.warmup()).resolves.toBeUndefined();
		expect((plugin as unknown as { hasWarmedUp: boolean }).hasWarmedUp).toBe(false);
	});

	it("warmup() returns immediately when disabled", async () => {
		const plugin = new KokoroPlugin({ enabled: false });

		await expect(plugin.warmup()).resolves.toBeUndefined();
		expect(logSpy).not.toHaveBeenCalled();
	});

	it("speak() returns immediately when disabled", async () => {
		const plugin = new KokoroPlugin({ enabled: false });

		await expect(plugin.speak("Hello world")).resolves.toBeUndefined();
		expect(logSpy).toHaveBeenCalledWith("[KokoroPlugin] Disabled, skipping TTS.");
	});

	it("speak() warns and returns in Node when enabled", async () => {
		const plugin = new KokoroPlugin();

		await expect(plugin.speak("Hello world")).resolves.toBeUndefined();
		expect(warnSpy).toHaveBeenCalledWith("[KokoroPlugin] Browser APIs are unavailable.");
	});

	it("speak() handles empty input gracefully", async () => {
		const plugin = new KokoroPlugin();

		await expect(plugin.speak("")).resolves.toBeUndefined();
		await expect(plugin.speak("   ")).resolves.toBeUndefined();
		await expect(plugin.speak("```\n```")).resolves.toBeUndefined();
	});

	it("does not throw when stopped in Node", () => {
		const plugin = new KokoroPlugin();

		expect(() => {
			plugin.stop();
			plugin.stop();
		}).not.toThrow();
	});
});
