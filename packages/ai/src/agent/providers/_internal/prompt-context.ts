/**
 * Materialize a bounded chat transcript into the prompt.
 *
 * CLI runtimes that don't accept a structured history parameter need the
 * conversation surfaced inline until the runtime has a durable
 * provider-native session mapping.
 */

import type { AgentOptions } from "../../types";

const MAX_CONVERSATION_MESSAGES = 50;
const MAX_CONVERSATION_CHARS = 100_000;

export function addConversationContext(prompt: string, options?: AgentOptions): string {
	const conversation = options?.conversation;
	if (!conversation?.length) return prompt;

	const messages = conversation.slice(-MAX_CONVERSATION_MESSAGES);
	if (messages.at(-1)?.role === "user" && messages.at(-1)?.content.trim() === prompt.trim()) {
		messages.pop();
	}
	if (messages.length === 0) return prompt;

	let remaining = MAX_CONVERSATION_CHARS;
	const history: string[] = [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message || remaining <= 0) break;
		const content = message.content.slice(-remaining);
		remaining -= content.length;
		history.unshift(`[${message.role}]\n${content}`);
	}

	return `<conversation_history>\n${history.join("\n\n")}\n</conversation_history>\n\n[current_user_request]\n${prompt}`;
}
