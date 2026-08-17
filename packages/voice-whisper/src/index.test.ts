import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhisperPlugin } from "./index";

describe("WhisperPlugin", () => {
	describe("constructor", () => {
		it("uses default values when no options are provided", () => {
			const plugin = new WhisperPlugin();

			expect(plugin.enabled).toBe(true);
			expect(plugin.model).toBe("whisper-1");
			expect(plugin.apiKey).toBeUndefined();
			expect(plugin.baseUrl).toBe("https://api.openai.com/v1");
			expect(plugin.timeoutMs).toBe(600_000);
		});

		it("allows every option to be overridden", () => {
			const plugin = new WhisperPlugin({
				enabled: false,
				model: "whisper-large",
				apiKey: "sk-test",
				baseUrl: "https://custom.example.com",
				timeoutMs: 30_000,
			});

			expect(plugin.enabled).toBe(false);
			expect(plugin.model).toBe("whisper-large");
			expect(plugin.apiKey).toBe("sk-test");
			expect(plugin.baseUrl).toBe("https://custom.example.com");
			expect(plugin.timeoutMs).toBe(30_000);
		});
	});

	describe("ready", () => {
		it("is true only when enabled and an apiKey is present", () => {
			expect(new WhisperPlugin({ enabled: true, apiKey: "sk-test" }).ready).toBe(true);
			expect(new WhisperPlugin({ enabled: false, apiKey: "sk-test" }).ready).toBe(false);
			expect(new WhisperPlugin({ enabled: true }).ready).toBe(false);
			expect(new WhisperPlugin({ enabled: true, apiKey: "" }).ready).toBe(false);
			expect(new WhisperPlugin({ enabled: true, apiKey: "   " }).ready).toBe(false);
		});
	});

	describe("transcribe", () => {
		const originalFetch = globalThis.fetch;

		beforeEach(() => {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				headers: new Headers({ "content-type": "application/json" }),
				json: async () => ({ text: "hello world" }),
			});
		});

		afterEach(() => {
			globalThis.fetch = originalFetch;
			vi.restoreAllMocks();
		});

		const dummyBlob = () => new Blob(["audio"], { type: "audio/wav" });

		it("throws when the plugin is disabled", async () => {
			const plugin = new WhisperPlugin({ enabled: false });

			await expect(plugin.transcribe({ file: dummyBlob() })).rejects.toThrow("Speech-to-text is disabled.");
		});

		it("throws when apiKey is missing", async () => {
			const plugin = new WhisperPlugin({ enabled: true });

			await expect(plugin.transcribe({ file: dummyBlob() })).rejects.toThrow(
				"OPENAI_API_KEY is not configured for audio APIs.",
			);
		});

		it("throws when apiKey is empty or whitespace", async () => {
			const plugin = new WhisperPlugin({ enabled: true, apiKey: "   " });

			await expect(plugin.transcribe({ file: dummyBlob() })).rejects.toThrow(
				"OPENAI_API_KEY is not configured for audio APIs.",
			);
		});

		it("uses the input model override when provided", async () => {
			const plugin = new WhisperPlugin({ apiKey: "sk-test", model: "whisper-1" });

			await plugin.transcribe({ file: dummyBlob(), model: "whisper-large" });

			const body = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as FormData;
			expect(body.get("model")).toBe("whisper-large");
		});

		it("falls back to the plugin model when input model is omitted", async () => {
			const plugin = new WhisperPlugin({ apiKey: "sk-test", model: "custom-model" });

			await plugin.transcribe({ file: dummyBlob() });

			const body = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as FormData;
			expect(body.get("model")).toBe("custom-model");
		});

		it("falls back to the default model when no model is configured", async () => {
			const plugin = new WhisperPlugin({ apiKey: "sk-test" });

			await plugin.transcribe({ file: dummyBlob() });

			const body = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as FormData;
			expect(body.get("model")).toBe("whisper-1");
		});

		it("does not call fetch for disabled or unconfigured plugins", async () => {
			const disabled = new WhisperPlugin({ enabled: false });
			await expect(disabled.transcribe({ file: dummyBlob() })).rejects.toThrow();

			const unconfigured = new WhisperPlugin({ enabled: true });
			await expect(unconfigured.transcribe({ file: dummyBlob() })).rejects.toThrow();

			expect(globalThis.fetch).not.toHaveBeenCalled();
		});
	});
});
