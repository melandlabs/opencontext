/**
 * Heuristic for "this looks like the model refused because the prompt is
 * too large". The AI SDK exposes `APICallError` with a status code, so we
 * honour the upstream status (400 for OpenAI-compatible, 413 for some
 * Anthropic-compatible gateways) when present and fall back to the message
 * for providers that don't surface a clean code.
 *
 * Lives in the compaction module so both the standalone provider (error
 * classification) and the in-process compactor (retry-with-drop logic) can
 * share one definition.
 */
export function isContextOverflowError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const maybeError = err as { status?: number; statusCode?: number; message?: string; name?: string };
	const status = maybeError.status ?? maybeError.statusCode;
	if (status === 400 || status === 413) {
		// 400 / 413 alone aren't sufficient — we still need the message to
		// look like an overflow. Many other 400s (bad request, missing
		// tool, invalid `max_tokens`) should NOT be classified as overflow,
		// so keep the patterns specific and avoid a bare "tokens" match.
		const message = (maybeError.message ?? "").toLowerCase();
		return (
			message.includes("context") ||
			message.includes("too long") ||
			message.includes("too many tokens") ||
			message.includes("reduce the length") ||
			message.includes("prompt is too")
		);
	}
	const message = (maybeError.message ?? "").toLowerCase();
	return (
		(message.includes("context length") && message.includes("exceeded")) ||
		message.includes("context_length_exceeded") ||
		message.includes("maximum context length") ||
		message.includes("prompt is too long") ||
		(message.includes("context window") && message.includes("exceeded")) ||
		(message.includes("reduce the length") && message.includes("messages"))
	);
}
