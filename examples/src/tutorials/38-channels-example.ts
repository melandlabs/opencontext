/**
 * Tutorial: platform adapter error envelopes.
 *
 * Demonstrates the error-normalization helpers from
 * `@melandlabs/integrations-channels`:
 *
 *   - `makePlatformErrorEnvelope` builds a serializable error envelope.
 *   - `isPlatformErrorEnvelope` type-guards an unknown value.
 *   - `toPlatformAdapterError` wraps an arbitrary error/value in a rich adapter error.
 *   - `createPlatformAdapterError` creates an adapter error directly.
 *
 * The demo performs a round-trip from envelope -> adapter error -> envelope.
 *
 * Run:
 *   cd examples
 *   node --experimental-strip-types src/tutorials/38-channels-example.ts
 */

import {
	createPlatformAdapterError,
	isPlatformAdapterError,
	isPlatformErrorEnvelope,
	makePlatformErrorEnvelope,
	toPlatformAdapterError,
} from "@melandlabs/integrations-channels";
import { runIfMain } from "../_helpers.ts";

async function main() {
	// ---- Static surface checks ----
	console.log("Static surface checks:");
	console.log(`- makePlatformErrorEnvelope is callable: ${typeof makePlatformErrorEnvelope === "function"}`);
	console.log(`- isPlatformErrorEnvelope is callable: ${typeof isPlatformErrorEnvelope === "function"}`);
	console.log(`- toPlatformAdapterError is callable: ${typeof toPlatformAdapterError === "function"}`);
	console.log(
		`- createPlatformAdapterError is callable: ${typeof createPlatformAdapterError === "function"}`,
	);

	// ---- Real API: envelope creation and type guard ----
	console.log("\n--- makePlatformErrorEnvelope / isPlatformErrorEnvelope ---");
	const envelope = makePlatformErrorEnvelope("api_error", "Platform API returned an unexpected status.", {
		request_id: "req-12345",
	});
	console.log("- envelope:", JSON.stringify(envelope));
	if (!isPlatformErrorEnvelope(envelope)) {
		throw new Error("Expected makePlatformErrorEnvelope result to be a PlatformErrorEnvelope");
	}
	if (
		envelope.error.type !== "api_error" ||
		envelope.error.message !== "Platform API returned an unexpected status."
	) {
		throw new Error("Envelope did not retain the expected code/message");
	}
	if (envelope.request_id !== "req-12345") {
		throw new Error("Envelope did not retain request_id");
	}
	if (isPlatformErrorEnvelope({ type: "not-an-envelope" })) {
		throw new Error("Expected non-envelope value to be rejected");
	}

	// ---- Real API: envelope -> adapter error ----
	console.log("\n--- toPlatformAdapterError ---");
	const adapterError = toPlatformAdapterError("telegram", "sendMessage", envelope);
	console.log(`- adapter error type: ${adapterError.error.type}`);
	console.log(`- platform: ${adapterError.platform}, operation: ${adapterError.operation}`);
	if (!isPlatformAdapterError(adapterError)) {
		throw new Error("Expected toPlatformAdapterError result to be a PlatformAdapterError");
	}
	if (adapterError.platform !== "telegram" || adapterError.operation !== "sendMessage") {
		throw new Error("Adapter error did not preserve platform/operation context");
	}

	// Round-trip: adapter error serializes back to the original envelope.
	const roundTripped = adapterError.toJSON();
	console.log("- round-tripped envelope:", JSON.stringify(roundTripped));
	if (!isPlatformErrorEnvelope(roundTripped)) {
		throw new Error("Expected adapterError.toJSON() to produce a PlatformErrorEnvelope");
	}
	if (roundTripped.error.type !== envelope.error.type) {
		throw new Error("Round-tripped envelope did not preserve error type");
	}
	if (!roundTripped.error.message.includes(envelope.error.message)) {
		throw new Error("Round-tripped envelope message did not include the original message");
	}
	if (roundTripped.request_id !== envelope.request_id) {
		throw new Error("Round-tripped envelope did not preserve request_id");
	}

	// ---- Real API: create adapter error directly ----
	console.log("\n--- createPlatformAdapterError ---");
	const directError = createPlatformAdapterError(
		"slack",
		"postMessage",
		"rate_limit_error",
		"Too many requests; please retry after the rate-limit window.",
		{ request_id: "req-67890" },
	);
	console.log(`- direct error code: ${directError.error.type}`);
	if (!isPlatformAdapterError(directError)) {
		throw new Error("Expected createPlatformAdapterError result to be a PlatformAdapterError");
	}
	if (directError.error.type !== "rate_limit_error") {
		throw new Error("Direct adapter error did not retain the expected code");
	}
	if (directError.platform !== "slack" || directError.operation !== "postMessage") {
		throw new Error("Direct adapter error did not retain platform/operation");
	}

	console.log("\n[OK] Channels tutorial completed");
}

export default main;

runIfMain("Channels tutorial", main);
