// Ambient type declarations for the DSH ctx surface that dsh-opencontext
// actually touches. These mirror the public API of the peer deps; the
// plugins are loaded into a Cordis context that supplies these at runtime.

declare module "@deepseek-ai/cordis" {
	export interface Context {
		tools: { register(tool: unknown): () => void };
		on(event: string, handler: (...args: never[]) => unknown): () => void;
		get(name: string): unknown;
		logger: { warn(message: string): void; debug?(message: string): void; info?(message: string): void };
		effect(setup: () => () => void): () => void;
	}
}

declare module "@deepseek-ai/schemastery" {
	type Schema<T = unknown> = {
		(value: unknown): T;
	};
	interface Builder {
		object(shape: Record<string, unknown>): Schema;
		string(): { default(value: string): unknown; required(): unknown };
		number(): { default(value: number): unknown; required(): unknown };
		boolean(): { default(value: boolean): unknown; required(): unknown };
		array(item: unknown): unknown;
	}
	const z: Builder;
	export default z;
	export type { Schema };
}

declare module "@deepseek-ai/dsh-tools" {
	export function defineTool(definition: Record<string, unknown>): unknown;
}

declare module "@deepseek-ai/dsh-agent" {
	export type PreStepDecision =
		| { kind: "reject" }
		| { kind: "enter"; messages: unknown[] }
		| { kind: string; messages?: unknown[] };
	export type Agent = {
		session: { header: { id: string; cwd: string } };
	};
}

declare module "@deepseek-ai/dsh-llm" {
	export function createUserMessage(input: {
		content: Array<{ type: "text"; text: string }>;
		source: { kind: "plugin"; plugin: string };
	}): unknown;
}

declare module "@deepseek-ai/dsh-session" {
	export type UserMessage = {
		content: Array<{ type: string; text?: string }>;
	};
}

declare module "@deepseek-ai/dsh-system-prompt" {}
declare module "@deepseek-ai/dsh-skill" {
	interface SkillDefinition {
		name: string;
		description: string;
		body: string;
	}
	interface SkillService {
		register(definition: SkillDefinition): () => void;
	}
}
declare module "@deepseek-ai/dsh-commands" {
	interface CommandDefinition {
		name: string;
		description: string;
		handler: (invocation: {
			rawInput: string;
			signal: AbortSignal;
			agent: { session: { header: { id: string; cwd: string } } };
		}) => Promise<{ kind: "success" | "error"; text: string }>;
	}
	interface CommandService {
		register(definition: CommandDefinition): () => void;
	}
}
