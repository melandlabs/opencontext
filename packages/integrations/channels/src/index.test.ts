import { describe, expect, it, vi } from "vitest";
import {
	GroupMessageEvent,
	MessagePlatformAdapter,
	type MessageTarget,
	Permission,
	PlatformAdapterError,
	type PlatformAgentErrorCode,
	PrivateMessageEvent,
	createPlatformAdapterError,
	isPlatformAdapterError,
	isPlatformErrorEnvelope,
	makePlatformErrorEnvelope,
	platformErrorEnvelopeToWireMessage,
	toPlatformAdapterError,
} from "./index";

describe("error envelopes", () => {
	it("creates a valid error envelope", () => {
		const envelope = makePlatformErrorEnvelope("authentication_error", "bad credentials");
		expect(envelope).toEqual({
			type: "error",
			error: { type: "authentication_error", message: "bad credentials" },
		});
	});

	it("includes a request_id when provided", () => {
		const envelope = makePlatformErrorEnvelope("rate_limit_error", "slow down", { request_id: "req-1" });
		expect(envelope.request_id).toBe("req-1");
	});

	it("identifies valid and invalid error envelopes", () => {
		expect(isPlatformErrorEnvelope(makePlatformErrorEnvelope("api_error", "oops"))).toBe(true);
		expect(isPlatformErrorEnvelope({ type: "success", error: { type: "api_error", message: "x" } })).toBe(
			false,
		);
		expect(isPlatformErrorEnvelope({ type: "error", error: { type: "unknown_code", message: "x" } })).toBe(
			false,
		);
		expect(isPlatformErrorEnvelope({ type: "error", error: { type: "api_error" } })).toBe(true);
		expect(isPlatformErrorEnvelope({ type: "error", error: { message: "x" } })).toBe(false);
		expect(isPlatformErrorEnvelope(null)).toBe(false);
		expect(isPlatformErrorEnvelope("error")).toBe(false);
	});

	it("serializes an envelope to a wire message", () => {
		const envelope = makePlatformErrorEnvelope("not_found_error", "missing", { request_id: "req-2" });
		const wire = platformErrorEnvelopeToWireMessage(envelope);
		expect(JSON.parse(wire)).toEqual(envelope);
	});

	it("omits request_id from the wire message when absent", () => {
		const envelope = makePlatformErrorEnvelope("timeout_error", "took too long");
		const wire = platformErrorEnvelopeToWireMessage(envelope);
		expect(JSON.parse(wire)).not.toHaveProperty("request_id");
	});
});

describe("PlatformAdapterError", () => {
	it("wraps an envelope with context", () => {
		const envelope = makePlatformErrorEnvelope("permission_error", "nope");
		const error = new PlatformAdapterError(envelope, { platform: "slack", operation: "send" });

		expect(error.name).toBe("PlatformAdapterError");
		expect(error.platform).toBe("slack");
		expect(error.operation).toBe("send");
		expect(error.rawMessage).toBe("nope");
		expect(error.toJSON()).toEqual(envelope);
	});

	it("round-trips through toJSON", () => {
		const envelope = makePlatformErrorEnvelope("api_error", "boom", { request_id: "req-3" });
		const error = new PlatformAdapterError(envelope, { platform: "x", operation: "y" });
		expect(error.toJSON().request_id).toBe("req-3");
		expect(error.toJSON()).toEqual(envelope);
	});
});

describe("toPlatformAdapterError", () => {
	it("returns an existing PlatformAdapterError unchanged", () => {
		const existing = new PlatformAdapterError(
			makePlatformErrorEnvelope("authentication_error", "bad token"),
			{ platform: "telegram", operation: "login" },
		);
		expect(toPlatformAdapterError("telegram", "login", existing)).toBe(existing);
	});

	it("wraps a string error", () => {
		const error = toPlatformAdapterError("telegram", "send", "boom");
		expect(error).toBeInstanceOf(PlatformAdapterError);
		expect(error.message).toContain("[telegram] send failed: boom");
		expect(error.error.type).toBe("api_error");
	});

	it("uses HTTP status to classify errors", () => {
		const error = toPlatformAdapterError("slack", "post", { status: 429, message: "rate limited" });
		expect(error.error.type).toBe("rate_limit_error");
		expect(error.status).toBe(429);
	});

	it("extracts status from nested response objects", () => {
		const error = toPlatformAdapterError("slack", "post", { response: { status: 500 } });
		expect(error.status).toBe(500);
		expect(error.error.type).toBe("api_error");
	});

	it("extracts embedded error codes", () => {
		const error = toPlatformAdapterError("x", "y", {
			error: { type: "not_found_error" },
			message: "missing",
		});
		expect(error.error.type).toBe("not_found_error");
	});

	it("classifies credential and authentication keywords", () => {
		const error = toPlatformAdapterError("telegram", "login", "invalid access token");
		expect(error.error.type).toBe("authentication_error");
	});

	it("classifies network errors", () => {
		const error = toPlatformAdapterError("whatsapp", "connect", "fetch failed");
		expect(error.error.type).toBe("network_offline");
	});

	it("classifies timeouts", () => {
		const error = toPlatformAdapterError("telegram", "poll", "operation timed out");
		expect(error.error.type).toBe("timeout_error");
	});

	it("uses fallback options when classification fails", () => {
		const error = toPlatformAdapterError("x", "y", "", {
			fallbackCode: "internal_error",
			fallbackMessage: "fallback",
		});
		expect(error.error.type).toBe("internal_error");
		expect(error.rawMessage).toContain("fallback");
	});
});

describe("createPlatformAdapterError", () => {
	it("creates an error with a prefixed message", () => {
		const error = createPlatformAdapterError("slack", "send", "authentication_error", "bad token");
		expect(error.error.type).toBe("authentication_error");
		expect(error.message).toContain("[slack] send: bad token");
		expect(error.platform).toBe("slack");
	});
});

describe("isPlatformAdapterError", () => {
	it("recognizes instances", () => {
		const error = createPlatformAdapterError("x", "y", "api_error", "z");
		expect(isPlatformAdapterError(error)).toBe(true);
	});

	it("recognizes duck-typed objects", () => {
		expect(
			isPlatformAdapterError({
				name: "PlatformAdapterError",
				type: "error",
				error: { type: "api_error", message: "x" },
			}),
		).toBe(true);
	});

	it("rejects plain errors and other values", () => {
		expect(isPlatformAdapterError(new Error("x"))).toBe(false);
		expect(isPlatformAdapterError(null)).toBe(false);
		expect(isPlatformAdapterError("error")).toBe(false);
	});
});

class TestAdapter extends MessagePlatformAdapter {
	public sent: Array<{ target: MessageTarget; id: string; messages: string[] }> = [];
	public calls: string[] = [];

	async sendMessages(target: MessageTarget, id: string, messages: string[]): Promise<void> {
		this.sent.push({ target, id, messages });
	}

	async run<T>(
		operation: string,
		action: () => Promise<T>,
		opts?: { fallbackCode?: PlatformAgentErrorCode },
	) {
		return this.runWithAdapterError(operation, action, opts);
	}

	wrap(operation: string, error: unknown) {
		return this.toAdapterError(operation, error);
	}

	create(operation: string, code: PlatformAgentErrorCode, message: string) {
		return this.createAdapterError(operation, code, message);
	}
}

describe("MessagePlatformAdapter base behavior", () => {
	it("derives the adapter name from the constructor or instance name", () => {
		const unnamed = new TestAdapter();
		expect(unnamed.wrap("op", "boom").platform).toBe("Test");

		unnamed.name = "CustomBot";
		expect(unnamed.wrap("op", "boom").platform).toBe("CustomBot");
	});

	it("delegates sendMessage to sendMessages", async () => {
		const adapter = new TestAdapter();
		await adapter.sendMessage("private", "user-1", "hello");
		expect(adapter.sent).toHaveLength(1);
		expect(adapter.sent[0]).toEqual({ target: "private", id: "user-1", messages: ["hello"] });
	});

	it("registers and unregisters listeners", () => {
		const adapter = new TestAdapter();
		const handler = vi.fn();
		adapter.registerListener("private", handler);
		// biome-ignore lint/suspicious/noExplicitAny: platform-specific opaque type
		expect((adapter as any).listeners.get("private")).toBe(handler);

		adapter.unregisterListener("private");
		// biome-ignore lint/suspicious/noExplicitAny: platform-specific opaque type
		expect((adapter as any).listeners.has("private")).toBe(false);
	});

	it("returns this from listener helpers for chaining", () => {
		const adapter = new TestAdapter();
		expect(adapter.registerListener("group", vi.fn())).toBe(adapter);
		expect(adapter.unregisterListener("group")).toBe(adapter);
	});

	it("runWithAdapterError returns successful results", async () => {
		const adapter = new TestAdapter();
		const result = await adapter.run("fetch", async () => 42);
		expect(result).toBe(42);
	});

	it("runWithAdapterError wraps thrown errors", async () => {
		const adapter = new TestAdapter();
		await expect(
			adapter.run("fetch", async () => {
				throw new Error("boom");
			}),
		).rejects.toBeInstanceOf(PlatformAdapterError);
	});

	it("createAdapterError creates a prefixed adapter error", () => {
		const adapter = new TestAdapter();
		const error = adapter.create("send", "permission_error", "not allowed");
		expect(error.platform).toBe("Test");
		expect(error.operation).toBe("send");
		expect(error.error.type).toBe("permission_error");
		expect(error.message).toContain("[Test] send: not allowed");
	});

	it("exposes getAdapterName via the wrapped error platform", () => {
		class SlackTestAdapter extends MessagePlatformAdapter {}
		const adapter = new SlackTestAdapter();
		const error = toPlatformAdapterError(adapter.name || "slack", "send", "boom");
		expect(error.platform).toBe("slack");
	});
});

describe("events", () => {
	it("constructs private and group message events", () => {
		const friend = { id: "u1", name: "Alice" };
		const privateEvent = new PrivateMessageEvent(friend, ["hello"]);
		expect(privateEvent.targetType).toBe("private");
		expect(privateEvent.sender).toBe(friend);
		expect(privateEvent.attachments).toEqual([]);

		const group = { id: "g1", name: "Engineering", permission: Permission.Member };
		const member = {
			id: "u2",
			memberName: "Bob",
			permission: Permission.Owner,
			group,
			specialTitle: "",
			joinTimestamp: new Date(0),
			lastSpeakTimestamp: new Date(0),
			muteTimeRemaining: 0,
		};
		const groupEvent = new GroupMessageEvent(member, ["hi team"]);
		expect(groupEvent.targetType).toBe("group");
		expect(groupEvent.group).toBe(group);
	});
});

describe("Permission enum", () => {
	it("exposes the expected permission levels", () => {
		expect(Permission.Member).toBe("MEMBER");
		expect(Permission.Administrator).toBe("ADMINISTRATOR");
		expect(Permission.Owner).toBe("OWNER");
	});
});
