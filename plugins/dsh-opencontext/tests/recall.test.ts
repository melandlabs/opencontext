import { describe, it, expect, beforeEach, vi } from "vitest";
import { registerRecall } from "../src/recall.js";
import { makeConfig, makeFakeBackend, makeSearchHit } from "./_helpers.js";

type Handler = (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>;

interface RegisteredListener {
	event: string;
	handler: Handler;
}

const listeners: RegisteredListener[] = [];

type CtxShape = Parameters<typeof registerRecall>[0];

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

describe("registerRecall", () => {
	it("registers an agent/pre-step listener", () => {
		const backend = makeFakeBackend();
		registerRecall(ctx, backend, makeConfig());
		expect(ctx.on).toHaveBeenCalledWith("agent/pre-step", expect.any(Function));
		expect(listeners).toHaveLength(1);
	});

	it("returns next() unchanged when messages are empty", async () => {
		const backend = makeFakeBackend();
		registerRecall(ctx, backend, makeConfig());
		const downstream = vi.fn(async () => ({ kind: "enter", messages: ["x"] }));
		const out = await runListener({ messages: [] }, downstream);
		expect(downstream).toHaveBeenCalled();
		expect(out).toEqual({ kind: "enter", messages: ["x"] });
	});

	it("appends a prepared context message to the downstream decision", async () => {
		const backend = makeFakeBackend({
			search: vi.fn(async () => [makeSearchHit({ id: "h1", content: "alpha" })]),
		});
		registerRecall(ctx, backend, makeConfig());
		const downstream = async () => ({
			kind: "enter",
			messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
		});
		const out = (await runListener(
			{
				messages: [{ role: "user", content: [{ type: "text", text: "tell me about alpha" }] }],
				session: { header: { id: "s1", cwd: "/tmp" } },
			},
			downstream,
		)) as { kind: string; messages: Array<{ meta?: { kind?: string } }> };
		expect(out.kind).toBe("enter");
		const recallMessage = out.messages.find((m) => m.meta?.kind === "recall");
		expect(recallMessage).toBeDefined();
		expect(recallMessage?.meta?.kind).toBe("recall");
	});

	it("degrades gracefully when backend.search throws", async () => {
		const backend = makeFakeBackend({
			search: vi.fn(async () => {
				throw new Error("down");
			}),
		});
		registerRecall(ctx, backend, makeConfig());
		const downstream = async () => ({ kind: "enter", messages: ["kept"] });
		const out = await runListener(
			{ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
			downstream,
		);
		expect(out).toEqual({ kind: "enter", messages: ["kept"] });
		expect(ctx.logger.warn as unknown as { mock: { calls: unknown[][] } }).toHaveBeenCalled();
	});

	it("does not modify the decision when recall is empty", async () => {
		const backend = makeFakeBackend({ search: vi.fn(async () => []) });
		registerRecall(ctx, backend, makeConfig());
		const downstream = async () => ({ kind: "enter", messages: ["kept"] });
		const out = await runListener(
			{ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
			downstream,
		);
		expect(out).toEqual({ kind: "enter", messages: ["kept"] });
	});

	it("passes through non-enter decisions unchanged", async () => {
		const backend = makeFakeBackend({ search: vi.fn(async () => [makeSearchHit()]) });
		registerRecall(ctx, backend, makeConfig());
		const downstream = async () => ({ kind: "reject" });
		const out = await runListener(
			{ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
			downstream,
		);
		expect(out).toEqual({ kind: "reject" });
	});
});
