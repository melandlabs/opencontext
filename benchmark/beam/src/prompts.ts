/**
 * Prompts for BEAM evaluation.
 *
 * BEAM uses nugget-based scoring (0.0 / 0.5 / 1.0 per atom) instead of
 * LongMemEval-style binary CORRECT/WRONG. We ship a single rubric-style
 * prompt + a 1-shot example to reduce judge variance.
 */

export const BEAM_NUGGET_JUDGE_PROMPT = `
You are an impartial judge scoring a generated answer against a list of "nugget atoms" — the smallest units of information the answer is expected to contain.

QUESTION CATEGORY: {category}

QUESTION: {question}

NUGGET ATOMS (the answer should support each one):
{atoms}

GENERATED ANSWER:
{answer}

RUBRIC (per atom):
- 1.0 = The answer fully supports / explicitly contains the atom's information.
- 0.5 = The answer partially supports the atom (mentions the topic but is incomplete, hedged, or missing a key detail).
- 0.0 = The answer does not contain the atom's information, contradicts it, or is off-topic.

CATEGORY-SPECIFIC RULE:
- If the category is "abstention", INVERT the scoring:
    - Score 1.0 if the answer refuses, says it does not know, or otherwise abstains (the answer correctly declines to answer).
    - Score 0.5 if the answer is hedged (e.g. "I'm not sure but maybe...").
    - Score 0.0 if the answer hallucinates a confident answer (it should have abstained).
- For all other categories, use the rubric as written.

OUTPUT FORMAT (strict JSON, no extra text):
{
  "scores": [number, number, ...],   // one score per atom, in input order, each in {0.0, 0.5, 1.0}
  "reasoning": "one short paragraph explaining the per-atom scores"
}

EXAMPLES (1-shot):

Example 1 — non-abstention:
QUESTION CATEGORY: temporal_reasoning
QUESTION: How many days passed between Alice's flight to Tokyo and her return flight?
NUGGET ATOMS: ["Departure flight was on 2024-03-04", "Return flight was on 2024-03-18"]
GENERATED ANSWER: Alice flew to Tokyo on March 4, 2024 and came back on March 18, 2024, so 14 days elapsed.
{
  "scores": [1.0, 1.0],
  "reasoning": "Both dates are explicitly stated in the answer."
}

Example 2 — abstention (inverted):
QUESTION CATEGORY: abstention
QUESTION: What is Alice's social security number?
NUGGET ATOMS: ["The answer should refuse / abstain"]
GENERATED ANSWER: I don't have that information and I shouldn't share sensitive identifiers like that.
{
  "scores": [1.0],
  "reasoning": "The answer correctly abstains. Category is abstention, so the inverted rule applies and refusal scores 1.0."
}

Now score the real question above. Respond with ONLY the JSON object, nothing else.
`;
