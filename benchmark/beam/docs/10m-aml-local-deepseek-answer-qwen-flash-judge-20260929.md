# BEAM 10M local evaluation: DeepSeek Answerer and Qwen Flash Judge

Date: 2026-09-29. Status: completed local diagnostic run. This is not a hosted AML leaderboard score.

## Scope and configuration

The BEAM 10M dataset contains 10 conversations and 200 questions. This evaluation reused the saved AML-local retrieval input and its Top-12 evidence. It did not run another ingestion or search pass. The retrieval input SHA-256 is `0c7ca8cc0244b982452c2b05f0ba78a26b5dd266e444434981b8f37ccc8d47fb`.

| Stage | Recorded configuration |
|---|---|
| Retrieval | Saved OpenContext Top-12 results; 48 fused candidates per trace |
| Reranking | Local `Xenova/ms-marco-MiniLM-L-6-v2`, recorded as enabled in all 200 retrieval traces |
| Answerer | `deepseek/deepseek-v4-flash-0731` through OpenRouter |
| Rubric and event Judge | `qwen/qwen3.8-flash` through OpenRouter |
| Reasoning | Disabled by the local runner; all 200 successful answer requests reported zero reasoning tokens |
| Initial output budgets | Answer 512 tokens, rubric Judge 1,024 tokens, event equivalence 8 tokens |

The runner may raise a request's output budget after a truncated response, up to its configured ceiling of 8,192 tokens. It also applies bounded retries, rate-limit backoff, and checkpoints successful judgements and event-equivalence calls. These are local recovery policies. The answer and Judge prompt renderers, rubric parser, event matcher, and scoring functions come from the vendored BEAM pipeline.

Top-12 is a deliberate local setting; the public AML flow records Top-100. The saved retrieval evidence comes from a resumed local run. The answer and Judge work was also resumed after transport failures and recovery changes. This report describes the completed local result, not a frozen-code, fresh-database benchmark or an exact hosted evaluation.

## Result and completeness

The final artifacts contain **200 distinct answer IDs and 200 distinct judged IDs**. There are no missing questions or answer-hash mismatches. All 20 event-ordering questions have event metrics. The final judge status is `complete`, with no pending questions, at 2026-09-29 10:02:58 UTC.

| Measure | Result |
|---|---:|
| Mean per-question rubric score | **0.2693** |
| Perfect-score questions | 45/200 |
| Partially scored questions | 21/200 |
| Zero-score questions | 134/200 |
| Mean event-ordering rubric score | 0.0819 |
| Mean event F1 | 0.0494 |
| Mean event-alignment score | 0.0172 |

The 0.2693 value is a mean of per-question rubric scores, not a pass rate. The perfect-score proportion is 22.5%. Event F1 and event alignment are separate metrics and should not be read as question pass rates. Temporary network and provider failures were retried or resumed; no missing question was inserted into the final score as a zero.

| Question category | Questions | Mean rubric score | Zero | Perfect | Mean annotated-source recall@12 |
|---|---:|---:|---:|---:|---:|
| Abstention | 20 | 0.6000 | 8 | 12 | N/A |
| Contradiction resolution | 20 | 0.0188 | 18 | 0 | 0.5221 |
| Event ordering | 20 | 0.0819 | 16 | 0 | 0.0124 |
| Information extraction | 20 | 0.5750 | 8 | 11 | 0.6500 |
| Instruction following | 20 | 0.3250 | 13 | 6 | 0.1250 |
| Knowledge update | 20 | 0.6250 | 7 | 12 | 0.6483 |
| Multi-session reasoning | 20 | 0.0375 | 17 | 0 | 0.3171 |
| Preference following | 20 | 0.3500 | 11 | 4 | 0.2833 |
| Summarization | 20 | 0.0550 | 17 | 0 | 0.0226 across 16 annotated questions |
| Temporal reasoning | 20 | 0.0250 | 19 | 0 | 0.2125 |

Source recall measures the fraction of annotated required source-turn IDs present in the final evidence. It does not establish that the exact answer-bearing text from a matched source was displayed. Twenty-four questions lack annotated source IDs and are excluded from recall calculations.

## Main findings

### 1. Historical evidence is incomplete for multi-event questions

Across 176 questions with annotated sources, mean required-source recall@12 is **0.3169**. Eighty-six questions retrieve none of their annotated sources; only 34 retrieve all of them.

Event ordering is the clearest bottleneck. Its mean required-source coverage is **0.0149 among all 48 fused candidates** and **0.0124 in final Top-12 evidence**. Sixteen of 20 event-ordering questions have no annotated required source in their final evidence. Summarization also has very low final coverage, 0.0226 across its 16 annotated questions. Candidate retrieval, final selection, and the answer-bearing span shown to the model need separate inspection. Simply increasing final Top-K cannot recover sources absent from the 48 candidates.

The local reranker did run: all 200 traces record 48 inputs and 48 outputs, with both keyword and semantic candidates. Among the 176 annotated questions, mean required-source coverage increases from **0.2534 in fused pre-rerank Top-12** to **0.3169 in final Top-12**. It improves on 23 questions, worsens on six, and is unchanged on 147. This is a trace-level ranking diagnostic, not a measured change in answer score.

### 2. Contradictions and time questions need both evidence and careful interpretation

Contradiction resolution scores zero on 18/20 questions, while its mean source recall is 0.5221. Partial source coverage may still omit one side of a conflict. To identify the cause, inspect whether both statements are visible and whether the answer distinguishes an explicit later correction from an unresolved conflict.

Temporal reasoning scores zero on 19/20 questions and has mean source recall of 0.2125. A message sequence number describes message order; it cannot establish an event date or elapsed time on its own. This result does not isolate timestamp handling as the cause of every temporal failure.

For example, `10m_6_q_4` asks for seven dated musical ideas in order. None of its 18 annotated source turns appear in the final evidence; the answer says the context is insufficient. The benchmark answer is wrong, but the missing evidence is a directly observed upstream constraint on this question.

### 3. Some answers assert details unsupported by the displayed history

`10m_1_q_7` asks which Milvus version was being evaluated for more than one million documents. The annotated source is absent. The displayed context repeatedly mentions version 2.2.0 for that use case and includes a separate 2.3.1 passage about two million indexes. The answer selects 2.2.0, while the rubric requires 2.3.1. This case exposes missing target evidence and distracting near matches; it does not by itself prove a pure Answerer reasoning error.

`10m_1_q_0` asks for Johnny's qualifications. The retrieved context includes collaboration advice and hypothetical skill assignments. The answer asserts a security and documentation background, while the abstention rubric indicates that the requested qualifications are not established. Source role and factual versus hypothetical language matter when constructing evidence for personal-history questions.

## Recommended next work

1. **Improve candidate coverage for multi-event questions.** On a fixed set of event, summary, and cross-session questions, measure annotated-source coverage separately for keyword, semantic, fused candidate-48, and final Top-12. Test bounded query decomposition or date/topic-aware candidate collection without using gold sources or rubrics at runtime. Inspect the displayed answer-bearing spans, not only parent IDs.
2. **Preserve distinct and conflicting evidence.** Inspect whether near-duplicate guidance crowds out separate events, dates, or the opposing statement in a contradiction. Test evidence selection that retains relevant distinct messages and sufficient neighboring text within a bounded context budget.
3. **Audit Answerer use of the evidence.** Review a bounded sample in which the answer is wrong despite apparently useful displayed text. Classify missing evidence, conflicting evidence, unsupported assertion, and misread evidence before changing the model or prompting. Keep the vendored official prompts intact for comparable tests.
4. **Run a controlled follow-up after changes.** Freeze code, model routes, reasoning settings, dataset, and retrieval configuration. Use a fresh isolated database and complete outputs, then compare source coverage and answer scores together. Report any Top-12 experiment separately from public Top-100 behavior.

## Local artifacts

- [Retrieval input](../../aml-local/outputs-beam10m-top12-resume-20260928/beam/input.jsonl) and [retrieval traces](../../aml-local/outputs-beam10m-top12-resume-20260928/beam/retrieval-traces.jsonl)
- [Answers](../../aml-local/outputs-beam10m-flash-nothink-20260929/beam/answers.jsonl) and [judgements](../../aml-local/outputs-beam10m-flash-nothink-20260929/beam/judged.jsonl)
- [Answer configuration](../../aml-local/outputs-beam10m-flash-nothink-20260929/beam/answers-config.json), [judge configuration](../../aml-local/outputs-beam10m-flash-nothink-20260929/beam/judged-config.json), and [final status](../../aml-local/outputs-beam10m-flash-nothink-20260929/beam/judged-status.json)

The raw output directories are locally ignored. Preserve or export those artifacts separately if this report is shared; links to them will not resolve in a checkout that lacks the run data.
