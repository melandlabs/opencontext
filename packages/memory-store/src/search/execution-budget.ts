export interface SearchExecutionBudget {
	signal?: AbortSignal;
	/** Maximum wait per external retrieval operation. Defaults to five seconds. */
	sourceTimeoutMs?: number;
	/** Maximum wait for the complete search, including optional ranking. */
	searchTimeoutMs?: number;
}

/** Bound external work without letting a late resolution change returned evidence. */
export function boundedSearchOperation<Args extends unknown[], Result>(
	operation: (...args: Args) => Promise<Result>,
	budget: SearchExecutionBudget,
): (...args: Args) => Promise<Result> {
	const timeout = budget.sourceTimeoutMs ?? 5000;
	if (!Number.isFinite(timeout) || timeout <= 0)
		throw new TypeError("sourceTimeoutMs must be positive and finite");
	return (...args) =>
		new Promise<Result>((resolve, reject) => {
			const signal = budget.signal;
			if (signal?.aborted) {
				reject(signal.reason);
				return;
			}
			const cleanup = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			};
			const onAbort = () => {
				cleanup();
				reject(signal?.reason);
			};
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error(`Search operation exceeded ${timeout}ms waiting budget`));
			}, timeout);
			signal?.addEventListener("abort", onAbort, { once: true });
			Promise.resolve()
				.then(() => {
					signal?.throwIfAborted();
					return operation(...args);
				})
				.then(
					(value) => {
						cleanup();
						resolve(value);
					},
					(error: unknown) => {
						cleanup();
						reject(error);
					},
				);
		});
}
