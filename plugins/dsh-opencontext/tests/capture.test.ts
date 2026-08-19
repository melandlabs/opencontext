import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerCapture } from "../src/capture.js";
import { makeConfig, makeFakeBackend } from "./_helpers.js";

type Handler = (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>;
const listeners: Array<{ event: string; handler: Handler }> = [];

type CtxShape = Parameters<typeof registerCapture>[0];

const ctx = {
	on: vi.fn((event: string, handler: Handler) => {
		listeners.push({ event, handler });
		return () => {
			const i = listeners.findIndex((l) => l.event === event && l.handler === handler);
			if (i >= 0) listeners.splice(i, 1);
		};
	}),
	logger: { warn: vi.fn(), debug: vi.fn() },
} as unknown as CtxShape;

beforeEach(() => {
	listeners.length = 0;
	(ctx.on as unknown as { mockClear: () => void }).mockClear();
	(ctx.logger.warn as unknown as { mockClear: () => void }).mockClear();
});

async function runListener(payload: unknown, downstream: () => Promise<unknown>) {
	const listener = listeners[0];
	if (!listener) throw new Error("no listener registered");
	return listener.handler(payload, downstream);
}

describe("registerCapture", () => {
	it("is a no-op when capturePrompts=false", async () => {
		const backend = makeFakeBackend({ captureSource: vi.fn() });
		registerCapture(ctx, backend, makeConfig({ capturePrompts: false }));
		const downstream = async () => ({ kind: "enter", messages: [] });
		await runListener({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }, downstream);
		expect(backend.captureSource).not.toHaveBeenCalled();
	});

	it("captures the user message and returns the downstream decision", async () => {
		const captureSource = vi.fn(async () => ({ id: "m1" }));
		const backend = makeFakeBackend({ captureSource });
		registerCapture(ctx, backend, makeConfig({ capturePrompts: true, flushOnCapture: true }));
		const downstream = async () => ({ kind: "enter", messages: ["x"] });
		const out = await runListener(
			{
				messages: [{ role: "user", content: [{ type: "text", text: "remember this" }] }],
			},
			downstream,
		);
		expect(out).toEqual({ kind: "enter", messages: ["x"] });
		expect(captureSource).toHaveBeenCalledTimes(1);
		const firstCall = (captureSource.mock.calls[0] ?? []) as unknown[];
		expect(firstCall[0]).toMatchObject({ sourceType: "user_input" });
	});

	it("skips capture for content that looks like a secret", async () => {
		const captureSource = vi.fn();
		const backend = makeFakeBackend({ captureSource });
		registerCapture(ctx, backend, makeConfig({ capturePrompts: true, flushOnCapture: true }));
		await runListener(
			{
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: "key is sk-abcdefghijklmnopqrstuv" }],
					},
				],
			},
			async () => ({ kind: "enter", messages: [] }),
		);
		expect(captureSource).not.toHaveBeenCalled();
	});

	it("fires and forgets by default; errors do not block the turn", async () => {
		const captureSource = vi.fn(async () => {
			throw new Error("backend down");
		});
		const backend = makeFakeBackend({ captureSource });
		registerCapture(ctx, backend, makeConfig({ capturePrompts: true, flushOnCapture: false }));
		const out = await runListener(
			{ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
			async () => ({ kind: "enter", messages: ["x"] }),
		);
		expect(out).toEqual({ kind: "enter", messages: ["x"] });
		// Allow the fire-and-forget promise to settle.
		await new Promise((r) => setTimeout(r, 5));
		expect(captureSource).toHaveBeenCalled();
	});
});
