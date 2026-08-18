import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerCommand } from "../src/commands.js";
import { makeConfig, makeFakeBackend } from "./_helpers.js";

const registeredCommands: Array<{
	name: string;
	description: string;
	handler: (inv: {
		rawInput: string;
		signal: AbortSignal;
		agent: { session: { header: { id: string; cwd: string } } };
	}) => Promise<{ kind: "success" | "error"; text: string }>;
}> = [];

const commandsService = {
	register: vi.fn((definition: unknown) => {
		const c = definition as (typeof registeredCommands)[number];
		registeredCommands.push(c);
		return () => {
			const i = registeredCommands.findIndex((r) => r.name === c.name);
			if (i >= 0) registeredCommands.splice(i, 1);
		};
	}),
};

const ctx = {
	get: vi.fn((name: string) => {
		if (name === "commands") return commandsService;
		return undefined;
	}),
};

beforeEach(() => {
	registeredCommands.length = 0;
	commandsService.register.mockClear();
	ctx.get.mockClear();
});

describe("registerCommand", () => {
	it("registers the /oc command when the commands service is available", () => {
		const backend = makeFakeBackend();
		registerCommand(ctx, backend, makeConfig());
		expect(commandsService.register).toHaveBeenCalledTimes(1);
		expect(registeredCommands[0]?.name).toBe("oc");
	});

	it("skips registration when the commands service is absent", () => {
		const backend = makeFakeBackend();
		const noopCtx = { get: vi.fn(() => undefined) };
		const dispose = registerCommand(noopCtx, backend, makeConfig());
		expect(noopCtx.get).toHaveBeenCalledWith("commands");
		expect(dispose()).toBeUndefined();
	});

	it("/oc doctor returns a JSON status payload", async () => {
		const backend = makeFakeBackend({
			health: vi.fn(async () => ({
				ok: true,
				mode: "lib" as const,
				details: "db=/x",
			})),
		});
		registerCommand(ctx, backend, makeConfig({ scopeId: "s1" }));
		const cmd = registeredCommands[0];
		if (!cmd) throw new Error("not registered");
		const result = await cmd.handler({
			rawInput: "doctor",
			signal: new AbortController().signal,
			agent: { session: { header: { id: "s", cwd: "/tmp" } } },
		});
		expect(result.kind).toBe("success");
		const body = JSON.parse(result.text);
		expect(body.ok).toBe(true);
		expect(body.backend).toBe("lib");
		expect(body.scope).toBe("s1");
		expect(body.probe).toEqual({ ok: true, mode: "lib", details: "db=/x" });
	});

	it("/oc doctor reports failure when health is down", async () => {
		const backend = makeFakeBackend({
			health: vi.fn(async () => ({
				ok: false,
				mode: "lib" as const,
				details: "down",
			})),
		});
		registerCommand(ctx, backend, makeConfig());
		const cmd = registeredCommands[0];
		if (!cmd) throw new Error("not registered");
		const result = await cmd.handler({
			rawInput: "doctor",
			signal: new AbortController().signal,
			agent: { session: { header: { id: "s", cwd: "/tmp" } } },
		});
		expect(result.kind).toBe("error");
		const body = JSON.parse(result.text);
		expect(body.ok).toBe(false);
	});

	it("/oc unknown subcommand returns an error", async () => {
		const backend = makeFakeBackend();
		registerCommand(ctx, backend, makeConfig());
		const cmd = registeredCommands[0];
		if (!cmd) throw new Error("not registered");
		const result = await cmd.handler({
			rawInput: "frobnicate",
			signal: new AbortController().signal,
			agent: { session: { header: { id: "s", cwd: "/tmp" } } },
		});
		expect(result.kind).toBe("error");
		expect(result.text).toContain("frobnicate");
	});
});
