/**
 * demo: @melandlabs/ai — token estimation and credit pricing.
 *
 * Before you send a prompt you usually want two numbers: roughly how many
 * tokens it is, and what that will cost. `estimateTokens` answers the
 * first without a tokenizer download; `MODEL_PRICING` and the
 * `calculate*Credits` helpers answer the second.
 *
 * Credits are the billing unit: USD cost divided by `CREDIT_VALUE_USD`.
 */

import {
	CREDIT_VALUE_USD,
	MODEL_PRICING,
	calculateInputCredits,
	calculateOutputCredits,
	calculateTotalCredits,
	estimateTokens,
	getModelPricing,
} from "@melandlabs/ai";
import { info, makeCheck, runSection } from "../_helpers.ts";

const PROMPT = "Summarise the retrieval pipeline decision we made last Tuesday, in three bullets.";

export default async function demoAi() {
	await runSection("demo: @melandlabs/ai", async () => {
		const check = makeCheck("demo/ai");

		// 1. Estimate the prompt size.
		const tokens = estimateTokens(PROMPT);
		info("demo/ai", `estimateTokens(${PROMPT.length} chars) = ${tokens} tokens`);
		check("estimateTokens returns a positive integer", Number.isFinite(tokens) && tokens > 0, `${tokens}`);
		check(
			"a longer prompt estimates to more tokens",
			estimateTokens(PROMPT.repeat(3)) > tokens,
			`${estimateTokens(PROMPT.repeat(3))} > ${tokens}`,
		);

		// 2. Look up what a model costs.
		const model = "openai/gpt-5.5";
		const pricing = getModelPricing(model);
		info("demo/ai", `${model}: $${pricing.inputPricePerMillion}/M in, $${pricing.outputPricePerMillion}/M out`);
		check(
			`getModelPricing('${model}') returns a priced entry`,
			pricing.inputPricePerMillion > 0 && pricing.outputPricePerMillion > 0,
		);
		check(
			"output tokens cost more than input tokens",
			pricing.outputPricePerMillion > pricing.inputPricePerMillion,
		);
		check(
			"the pricing table is populated and includes this model",
			Object.keys(MODEL_PRICING).length > 10 && model in MODEL_PRICING,
			`${Object.keys(MODEL_PRICING).length} models`,
		);

		// Unknown models fall back to `default` rather than throwing, so a
		// new model id never breaks a billing path.
		const unknown = getModelPricing("some-model-that-does-not-exist" as never);
		info("demo/ai", `unknown model falls back to $${unknown.inputPricePerMillion}/M (the 'default' entry)`);
		check(
			"an unknown model falls back to the 'default' pricing entry",
			unknown.inputPricePerMillion === MODEL_PRICING.default.inputPricePerMillion,
		);

		// 3. Turn tokens into credits.
		const inCredits = calculateInputCredits(tokens, model);
		const outCredits = calculateOutputCredits(500, model);
		const total = calculateTotalCredits(tokens, 500, model);
		info("demo/ai", `${tokens} in + 500 out on ${model} = ${total.toFixed(2)} credits`);
		info("demo/ai", `1 credit = $${CREDIT_VALUE_USD}, so that's ~$${(total * CREDIT_VALUE_USD).toFixed(6)}`);

		check("input credits are positive", inCredits > 0, inCredits.toFixed(4));
		check("output credits are positive", outCredits > 0, outCredits.toFixed(4));
		check(
			"calculateTotalCredits equals input + output credits",
			Math.abs(total - (inCredits + outCredits)) < 1e-9,
			`${total.toFixed(6)}`,
		);
		check(
			"credits scale linearly with token count",
			Math.abs(calculateInputCredits(tokens * 2, model) - inCredits * 2) < 1e-9,
		);
		check("CREDIT_VALUE_USD is a positive USD rate", CREDIT_VALUE_USD > 0, `$${CREDIT_VALUE_USD}`);
	});
}
