/**
 * Native agent runner contract shared between runtime providers and the
 * `apps/web` HTTP entry point. Lives in `../native-runner`
 * so the request shape (and the error class thrown for invalid config) are
 * available to every consumer without pulling in `apps/web`.
 */

export interface NativeAgentRequest {
	provider: string;
	sessionId?: string;
	prompt?: string;
	modelConfig?: {
		model?: string;
		[key: string]: unknown;
	};
	providerConfig?: Record<string, unknown>;
	[key: string]: unknown;
}

export class NativeAgentRequestError extends Error {
	constructor(
		message: string,
		readonly statusCode: number = 500,
	) {
		super(message);
		this.name = "NativeAgentRequestError";
	}
}
