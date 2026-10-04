# BEAM 10M: Query Rewrite, Pinned-Provider Local Evaluation

## Scope and reproducibility

This is a **complete local** BEAM run, not an AML platform submission. The public BEAM answer and judge prompts, rubric parser, event-alignment algorithm, and metric were left unchanged. The local adapter used Top-12 rather than the public flow's Top-100; scores should not be presented as an official leaderboard result. The run reused 39,920 previously committed Add batches in the same 10M SQLite database; it did not independently rebuild the ingestion corpus.

| Setting | Value |
| --- | --- |
| Branch / frozen commit | `experiment/beam10m-query-rewrite` / `753c13d` |
| Dataset | `beam_10m.json`, 200 questions |
| Retrieval | Query rewrite, local MiniLM-L6-v2 embeddings, SQLite semantic + FTS5 BM25, RRF, local ms-marco-MiniLM-L-6-v2 reranker, Top-12 |
| Retrieval planner and answerer | `deepseek/deepseek-v4-flash-0731`, OpenInference, reasoning disabled |
| Judge, including event alignment | `qwen/qwen3.8-flash`, Alibaba, reasoning disabled |
| Artifacts | `benchmark/aml-local/outputs-beam10m-pinned-rewrite-20261002/beam/` |

Coverage is 200/200 retrieval traces, 200/200 answers, and 200/200 judgements, with no skipped questions. All 200 successful answer requests reported OpenInference. All 1,346 successful judge subrequests reported Alibaba; 58 failed attempts were recovered without changing provider. The reranker was enabled in all 200 retrieval traces. Query rewriting reported degradation on four traces.

The retrieval state records dataset SHA256 `f80b3ca1236c6933300cd89cc65f1062535b18ca86c733eb34a73309e8439978`. Provider fallback was disabled for the planner, answerer, rubric judge, and event-alignment judge. The public answer/judge prompts were not edited to obtain these scores.

## Core repairs and validation

The shared core was repaired before this comparison: FTS5's ascending negative rank is converted to a monotonically correct relevance score; exhausted vector widening retains partial matches and falls back to an exact search within the requested user's scope; parent deduplication and RRF fusion retain distinct matched child excerpts instead of only combining scores. Regression tests cover real FTS5 through parent deduplication and RRF, overlapping/distant source windows, and exhausted vector scans. A later test strengthens the vector case by putting the owned result behind every foreign-user vector within the widening budget. A subsequent regression also exposed aliasing of a source-chunk-ID array during evidence fusion; copying that array now prevents mutation of the original channel hits. This later repair concerns trace attribution, not a demonstrated QA-score gain in the frozen run.

The known 512-token **reranker input** truncation issue remains deferred, as requested. It was not silently treated as fixed.

The 200 successful answer API responses reported a mean of **8,382.34 input tokens**, median 8,481, nearest-rank P95 12,527, and maximum 13,408. These are provider-reported model-native counts for the complete answer prompt, not estimates from the 400-token chunk setting. Mean answer output was 67.865 tokens, maximum 417; all 200 finished with `stop`, at the official initial 512-token output budget, with zero reported reasoning tokens. These records do not show answer-output budget exhaustion; they do not establish the absence of every possible server-side input transformation.

## Outcome

The mean BEAM judge score was **0.2462** over all 200 questions. Query rewrite did not provide a meaningful retrieval lift against the fixed-code, same-database Top-12 baseline: annotated source-turn recall moved from **0.3374 to 0.3423** (+0.0049), with five questions improved, one worsened, and 170 unchanged. The baseline comparison is retrieval-only, not a paired answer-score comparison.

| Category | Questions | Mean judge score | Mean annotated source recall@12 |
| --- | ---: | ---: | ---: |
| Information extraction | 20 | 0.55 | 0.70 |
| Knowledge update | 20 | 0.50 | 0.69 |
| Abstention | 20 | 0.45 | N/A |
| Preference following | 20 | 0.44 | 0.30 |
| Instruction following | 20 | 0.31 | 0.12 |
| Multi-session reasoning | 20 | 0.07 | 0.34 |
| Event ordering | 20 | 0.06 | 0.01 |
| Contradiction resolution | 20 | 0.04 | 0.59 |
| Temporal reasoning | 20 | 0.03 | 0.23 |
| Summarization | 20 | 0.01 | 0.04 |

The reported source metric uses annotated source-turn IDs. It establishes that a parent turn was retrieved, **not** that the answer-bearing child span was visible or used correctly by the answerer.

## Evidence chain

Among 176 questions with source-turn annotations, all required source turns were present in the indexed dataset. Mean required-source recall changed as follows:

| Stage | Mean recall | Questions with any required source | Questions with all required sources |
| --- | ---: | ---: | ---: |
| Available in indexed corpus | 1.0000 | 176 | 176 |
| Candidate channels combined | 0.5017 | 133 | 63 |
| Fused, before reranking | 0.4010 | 110 | 46 |
| Final Top-12 | 0.3423 | 99 | 36 |

At least one required source disappeared entirely for 23 questions during candidate fusion and for another 11 during the final rerank/truncation step. These losses deserve inspection, but **disabling the reranker is not supported by the aggregate ablation**: at the same Top-12 budget, fused-before-rerank recall was 0.2822 and final-after-rerank recall was 0.3423. Keyword-only and semantic-only candidate orderings gave 0.2258 and 0.2637 respectively at Top-12. BM25 and semantic channels were wired; the CLI's optional entity-search provider was not wired, so entity candidates were zero. No insight or knowledge corpus was created for this raw-chat run.

The final results contained 738 hits with multiple matched spans, demonstrating that multi-span evidence was carried through the repaired path. The exact answer-bearing span still needs case-level inspection; this count alone is not proof that every answer was visible.

Source coverage is a strong but incomplete predictor of score. The 36 questions with all annotated source turns in Top-12 averaged 0.55, but 13 of those still scored zero. The 77 questions with no annotated source in Top-12 averaged 0.15; 59 scored zero. Thus both retrieval loss and answer/interpretation failure matter.

## Case-level cautions

The following are **apparent question/rubric ambiguities**, not evidence that the system should be tuned to repeat the rubric's number:

- `10m_2_q_7` asks how many points were simulated while mocking sensor APIs with `unittest.mock`. A retrieved user message explicitly says **10,000 Lidar points**, and the answerer said 10,000. The rubric requires **5,000**, drawn from another message about mocked sensor inputs and coverage. Those are not obviously the same event.
- `10m_2_q_10` asks what capacity the log tool *supports* without downtime. A retrieved message says it supports **1,000 events/minute** and proposes increasing to **1,200**; another zero-downtime log-tool message also says **1,000**. The answerer said 1,000, while the rubric requires 1,200.
- `10m_1_q_3` has both annotated source turns in the final context, but the answer was only “Yes” and received zero. The rubric expects a detailed contradiction and clarification. Its cited statements (“always include exact error messages” and “never logged errors”) are also not logically contradictory by themselves. This is a mixture of insufficient answer explanation and questionable rubric framing.

These are examples, not a quantified dataset error rate. The official judge output is reported unchanged.

Two failures also have **directly visible answer-bearing text**, without relying only on source IDs:

- `10m_9_q_6`: the first returned user excerpt explicitly says a **50-page album for $75**, but the answer discusses selecting photos for an album with eight pages to fill. It addresses a historical question rather than the evaluation question.
- `10m_9_q_13`: returned user excerpts at ranks 1 and 5 explicitly allocate **1.5 hours** to the first island and **2 hours** to the second. The answer says the combined duration is unspecified, despite these visible inputs supporting 3.5 hours.

These cases establish an answerer/question-following problem in addition to retrieval loss. They do not prove that every full-source zero-score case has adequate answer-bearing context.

## Optimization priorities

A read-only lexical ablation covered all 200 questions on the unchanged database. It removed common English function words and deduplicated keywords **before** the existing 16-keyword cap; 115 questions exceeded that cap under the original tokenizer. Original FTS5 candidate order was reconstructed, including a replay to correct the analysis tokenizer's treatment of `x_n`. Exact source mappings came from the existing BEAM adapter helper, not guessed message sequence values.

Across 176 annotated questions, mean BM25 **candidate recall@48** moved from **0.3165 to 0.3357** (+0.0192): 21 improved, 10 worsened, and 145 were unchanged. This is not a reranked Top-12 or QA-score gain. The small lift and regressions do not justify enabling this normalization globally without a final-ranking and answer-score ablation. The combined stopword-filtering prototype was not enabled in production. A later minimal deduplication-only core change is evaluated separately in the iterative final report. Detailed results are in the ignored local artifact `benchmark/aml-local/outputs-beam10m-keyword-ablation-20261003/beam/analysis.json`.

1. Improve **answer-bearing source coverage** before adding more query rewrites. The candidate stage has relevant turns that are lost during fusion and Top-12 selection; use stage-level traces and matched spans to improve candidate ranking without hardcoding benchmark answers.
2. Treat event ordering and broad summarization as **coverage-limited tasks**. Event-ordering questions require a mean of 38 annotated turns; 19/20 require more than Top-12 can hold if each turn needs its own hit. A separate Top-K/context-budget ablation is needed before claiming these categories can be solved under the current cap.
3. Investigate answerer interpretation on full-source failures, especially contradiction resolution and temporal reasoning, while keeping official answer/judge prompts unchanged. Distinguish missing exact spans, conflicting historical facts, and rubric ambiguity from model failure.
4. Compare the independently pinned iterative-union result before selecting a default reasoning strategy. Query rewrite's measured gain here is small and does not justify an unconditional extra LLM call. The complete union run subsequently scored 0.2844 versus 0.2462 here; most of the difference came from abstention, not a substantial annotated-source recall lift. See the iterative final report for the matched comparison and core ablations.

## Optional modules and bounded follow-up experiments

Query rewrite and iterative recall are existing optional core modules, now supplied with the pinned Flash completion callback by the CLI. Iterative union retains the original-query semantic and BM25 channels and adds planner evidence; internal planner searches also fuse the two channels by RRF rather than comparing raw BM25 and cosine scores.

The CLI still does not implement `entitySearch`. That is an optional host dependency, not an environment toggle that can activate an already-populated entity index. Insights and knowledge search have selectable CLI backends, but this run's AML Add path ingests raw messages only, and Search requests the memory source. Merely enabling those backends would not create extracted facts or an evidence-linked knowledge corpus. They are not claimed as tested improvements here. Lifecycle/dreaming work remains outside this experiment.

Two follow-up diagnostics use the same preselected 20 question IDs (two per category, selected by the lowest SHA256 of question IDs), the unchanged database, the same models/providers, and unmodified official prompts. Both completed all 20 answers and judgements on 2026-10-04 after resuming the previously rate-limited questions. Existing answers were preserved; failed questions were not scored zero:

- Lossless quoting of historical excerpts kept retrieval fixed. The mean score was **0.0750**, versus **0.2600** for the same 20 original answers: zero improvements, five regressions, and fifteen unchanged. The regression on `10m_4_q_8` was 1.0 to 0.0. All 20 successful answer requests reported OpenInference and all 50 successful judge subrequests reported Alibaba, with zero provider mismatches. This presentation prototype is not enabled in production.
- A structured-chat iterative-union diagnostic preserves real system/user/assistant roles instead of flattening the planner's history into one user message. All 20 retrievals, answers, and judgements completed; all 20 successful answer responses reported DeepSeek Flash/OpenInference and all 50 successful judge subrequests reported Qwen Flash/Alibaba, with zero provider mismatches. Its mean score was **0.2500**; the 18 source-annotated questions had mean source recall **0.3750**, and 12 planner traces were degraded. The isolated real-CLI protocol check completed search -> note -> finish using OpenInference with zero reasoning tokens; this establishes correct transport, not a full-run score gain. Comparing 0.2500 with the rewrite subset's 0.2600 changes both retrieval strategy and planner transport, so it does not isolate the chat-role fix. The completed matched flat-history union subset scored **0.2250**: two scores improved, one worsened and seventeen were unchanged. This small diagnostic does not establish a full-run improvement.

Top-12 also imposes a mean annotated-source recall ceiling of 0.4314 on the 20 event-ordering questions, even with an ideal ranking: 19 questions require more than twelve distinct source turns. This is a ceiling for the source-ID metric, not proof that a smaller number of retrieved messages can never contain a useful timeline summary. Neither 20-question diagnostic score is substituted for a complete 200-question result. A score above 0.5 has not been demonstrated under this run's constraints.

The full iterative-union comparison and the completed wider-window, lexical-deduplication and planner-budget core ablations are documented in [the iterative final report](10m-aml-local-iterative-recall-final-20261004.md). The wider rerank window and default planner-budget hints were withdrawn after regressions; the apparent lexical-deduplication score gain came entirely from unchanged contexts and is not attributed to the core change. No default score improvement above the complete frozen runs is claimed.

Shared post-run correctness repairs and diagnostics were synchronized to both experiment branches. Relevant scoped tests, package builds and type checks passed; no full CI suite was run. These later checks are not a new complete benchmark of the final shared source. All test stages finished and test-owned services were stopped; the reused database and complete artifacts remain available locally.

No code or benchmark artifacts from this run were pushed.

The user subsequently required a complete score above 0.5 before stopping optimization. Work has resumed; the final-score evidence above remains unchanged. The new core-only, fixed-retrieval extractive-evidence experiment and its completion gate are tracked in the iterative report, without creating a third report or changing official benchmark prompts.

Two independent twenty-question context interventions have now completed under the fixed Flash models/providers: validated extractive excerpts scored **0.20000**, and bounded original-dialogue pairs scored **0.22083**, compared with the fresh union diagnostic control's **0.25625**. Neither is promoted; exact evidence/provenance is recorded in the iterative report.

The next module is an opt-in evidence-expression rewriter. It retains the original query and generates up to three complementary, question-grounded search expressions rather than one user-voice question. It does not invent answers or dates, change official AML prompts, modify the corpus, or enable context-expansion features. Additional variants and their cost are part of the intervention. A fresh twenty-question user-voice control and its matched evidence-expression arm completed under `outputs-beam10m-evidence-query-control-20261004` and `outputs-beam10m-evidence-query-ablation-20261004`, using the same independently selected question IDs, production SQLite retrieval and the actual local reranker.

### Completed evidence-expression diagnostic

Both arms completed all twenty answers and judgements. Mean QA score was **0.23125 versus 0.21250** for the fresh control: two questions improved, one worsened and seventeen were unchanged. `10m_4_q_8` improved from 0 to 0.5 and `10m_9_q_2` from 0 to 0.125; `10m_1_q_8` worsened from 0.25 to 0. Source Recall@12 on eighteen annotated questions was **0.37685 versus 0.37222**, with one improvement, one regression and sixteen unchanged. This small diagnostic gain is not a complete-run result, proof of reliable historical-requirement discovery, or completion of the score-above-0.5 goal. Evidence expressions remain opt-in.

Each arm had twenty active local-reranker traces and zero degraded query rewrites. Each had twenty successful DeepSeek Flash/OpenInference answers and fifty successful Qwen Flash/Alibaba judge subrequests, with zero successful-provider mismatches. The control recovered one failed judge attempt; the evidence arm had none. Official prompts and the persisted corpus were unchanged. Core commit `288e58f` and the frozen CLI/search bundles identify the tested implementation; later experiments must not be represented as results of that snapshot.

A separate fixed-candidate core reranker diagnostic completed twenty rankings, answers and judgements with score **0.29208 versus this fresh control's 0.21250**. Three improved, one worsened and sixteen were unchanged, while annotated-source Recall@12 decreased from 0.37222 to 0.35926. The scorer stays default-off; this is not a full-run improvement. Its strict protocol recovery, frozen-response reuse, provider audit and the next independent listwise comparison are recorded in the iterative final report. Only these two final reports are retained, and nothing has been pushed.

The subsequent listwise diagnostic completed twenty rankings, answers and judgements with score **0.35000 versus 0.21250**, four improvements, one regression and fifteen unchanged. Source Recall@12 fell to 0.33241, so this is not claimed as an annotated-source retrieval gain. All ranking/answer requests used the required OpenInference route and all fifty judge subrequests used Alibaba, without failures or provider mismatches. A separate full-200 fixed-candidate confirmation is now using the frozen iterative-union retrieval control (score 0.28442); its result is not yet available. The iterative final report records its exact scope, preflight and artifacts. The score-above-0.5 goal remains active.

The listwise case audit confirms that the required 15% fact was already visible in both contexts for one improved answer, and another improvement was correct abstention. Most of the gain over pointwise ranking on this small subset came from the two abstention questions, not substantially better annotated-source retrieval. Full-ranking continuations preserved 188 and then 198 valid selections; repeated indices prevented premature answer/judge stages. The optional core now has bounded, locally validated single-choice recovery. The corrected full confirmation revalidates 198 frozen accepted responses and generates the remaining selections under the same providers; it is not described as 200 fresh native-schema calls. Its protocol, source identity and pending completion gate are documented in the iterative final report. No new complete QA score or score-above-0.5 success is claimed.

The full listwise confirmation has now completed all 200 questions: **0.25572 versus the frozen union control's 0.28442**, with sixteen improvements, twenty-one regressions and 163 unchanged scores. All contexts changed and all question/rubric fields remained identical. Source Recall@12 decreased to 0.26831. All 200 successful answer calls used OpenInference and all 935 successful judge subrequests used Alibaba, with zero provider mismatches and zero reported reasoning tokens; all bounded retries recovered. The scorer stays default-off. The earlier small-subset gain did not generalize, and the complete score-above-0.5 goal remains active.

The next independent rewrite experiment is **opt-in lexical query rewriting**, not another answer/judge prompt or model change. `UnifiedSearchReasoningDeps.rewriteLexical` and `OPENCONTEXT_LLM_QUERY_REWRITE_LEXICAL=1` apply up to four original-first, distinct expressions to BM25 under RRF. Cross-query raw BM25 values are never directly compared; downstream parent sorting retains the folded rank. Existing filters, source spans, candidate budget, local q8 reranker and its deferred 512-token behavior remain intact. A read-only, zero-paid-call lexical probe suggests small candidate-coverage gains, not a QA improvement. Fifty-five scoped tests, relevant type checks and the memory-store build passed.

The actual-core matched experiment under `outputs-beam10m-lexical-rewrite-ablation-20261005` freezes the pre-change and current search modules, replays the same twenty evidence-expression queries and semantic candidates, and performs real FTS5 retrieval and local cross-encoder reranking. The completed evidence-expression arm (0.23125) is its control; every original full context must replay exactly. It records each keyword request/raw FTS rank and the separate lexical, semantic, fusion and post-rerank evidence. Official prompts, fixed Flash providers and the persisted corpus are unchanged, and no new planner generations are required. This module remains default-off until its independent score is known; nothing has been pushed.

### Completed lexical-rewrite diagnostic

All twenty retrievals, answers and judgements completed. Mean QA score was **0.26875 versus 0.23125**: two questions improved, one worsened and seventeen were unchanged. `10m_1_q_8` changed from 0 to 0.25, `10m_2_q_15` from 0 to 1, and `10m_4_q_8` from 0.5 to 0. All twenty complete contexts changed; every original FTS order/text, fused pool and local-reranker answer context was verified exactly before the intervention. Twenty local-reranker traces were active. Eighteen annotated questions' final Source Recall@12 fell from **0.37685 to 0.36574**: `10m_1_q_16` fell from 0.25 to 0, `10m_3_q_4` rose from 0.05 to 0.1, and sixteen were unchanged. More lexical candidates therefore did not establish higher final coverage.

The required 15% fact for the largest score improvement was explicitly present in two contexts in **both** arms. That case supports a context-composition/answer-use hypothesis, not discovery of a missing fact. This single-completion small diagnostic is not sufficient to promote the module or claim a full-run gain. `rewriteLexical` remains default-off.

All twenty successful answer calls reported DeepSeek Flash/OpenInference; all fifty successful judge subrequests reported Qwen Flash/Alibaba. Reported reasoning tokens and successful-provider mismatches were zero. One upstream judge 429 recovered within the bounded policy, with no skipped questions. The baseline/current search hashes are `88119222ca256f222c4df985fc5416bd78a35b095a3557891c88f0e401bb073f` and `63e065f407e307d09ea6458d226fe5e6c7617371f84460dd7b8e45dd01efc2a3`; the frozen harness is `57e0e13d118356349634c1ee49e3a2533d828cc5c9e66d661f2b46ffd1aa68d4`. Its initial isolated-bundle import lacked workspace dependencies; a runtime-only dependency junction fixed that before the first accepted retrieval. This does not change the corpus, scoring implementation or official prompts. No full-score-above-0.5 success or push has occurred.


### Structured iterative observation diagnostic (in progress, 2026-10-05)

The iterative branch now provides a default-off `observationFormat: "structured"` planner option, exposed by `OPENCONTEXT_LLM_ITERATIVE_OBSERVATION_FORMAT=structured`. The unchanged default is `text`; unsupported CLI values fail clearly. Structured observations whitelist historical source roles, positive safe-integer ingestion sequences and finite optional Unix-millisecond timestamps. History is JSON-quoted, metadata semantics reuse existing message-order guidance, and the current research question follows the quoted results. No missing timestamps are invented; retrieval rank and one-based note indices are unchanged. This is a joint evidence-representation intervention, not an isolated causal claim about individual metadata fields.

Four scoped test files passed **104 tests**, including initial-prompt compatibility, quoting, metadata validation, empty results, action budgets and CLI wiring. Memory-store/OpenContext type checks and the memory-store build passed; no full CI was run.

A paired twenty-question diagnostic is running under `outputs-beam10m-iterative-observations-ablation-v2-20261005` on the iterative branch. Both arms run actual core union retrieval against the existing read-only corpus, real sqlite-vec/FTS5 queries, fp32 MiniLM embeddings and unchanged q8 MiniLM reranking (512 tokens, batch eight). The fixture loads sqlite-vec and attaches the existing index without invoking the manager's destructive index-rebuilding initializer. Native queries and hydration remain production code. The first planner response is replayed only when initial message hashes match; later actions are fresh. Identical native requests may share immutable results. Four planner actions, five visible results per search, candidate budget 48 and final Top-12 are unchanged. Gold source annotations/rubrics never reach planner or ranking models. Channel hits, planner messages/responses, fused spans and final contexts are recorded separately, with per-arm checkpoints and answer inputs. Official answer/judge prompts and DeepSeek/OpenInference plus Qwen/Alibaba remain unchanged. QA results are pending; no gain, default promotion, push or completion of the score-above-0.5 gate is claimed.

The initial diagnostic driver was stopped before any answer or judgement: its embedder adapter passed the scoped SDK request object instead of its query string to the tokenizer. Thirteen early retrieval checkpoints are invalid and excluded. This was a local harness wiring error, not a production-core finding or corpus corruption. The corrected adapter validates string inputs and records query text plus embedding hashes; the v2 run starts in a new directory and does not reuse invalid retrieval checkpoints.


### Completed structured-observation diagnostic

The v2 run completed **20/20 retrievals, answers and judgements in both arms**. The structured arm scored **0.25000 versus 0.25625**: one improvement, two regressions and seventeen unchanged scores. `10m_4_q_8` improved from 0 to 1; `10m_5_q_10` fell from 1 to 0; `10m_9_q_2` fell from 0.125 to 0. Seventeen complete answer contexts changed, while the three identical-context pairs had identical scores. The option remains default-off; improved planner execution did not establish a QA gain.

Planner degradation fell from **13/20 to 6/20**, but final annotated-source Recall@12 remained **0.37500** in both arms, unchanged for every one of the eighteen annotated questions. Native candidate coverage across every executed search was 0.56852 versus 0.58547, while ordinary original-question channel coverage was 0.50556 in both arms. These are unconstrained unions of candidates, not Top-12 or answer-bearing-sentence coverage. The experiment made 137 new successful planner calls and twenty hash-validated first-response replays, all OpenInference. Both arms' forty successful answer calls used OpenInference; one hundred successful judge subrequests used Alibaba. Provider mismatches and reported reasoning tokens were zero. Two connection failures on the structured arm's first answer recovered on its third bounded attempt. No question was skipped or assigned a fabricated zero.

The frozen planner/index bundle SHA256 is `68af8b254dfd8c72610c03039159110dd26902b8ded8219965d01b9bc6efcb37`; the unchanged unified-search bundle is `9d4bf3006aed32ccde4fcb3eb3b8b8181a7a786f9a74ac0cad146f7f93be7bb2`; the corrected harness is `d8240912f930cbc2c41c9039613d26f1db4d2b00c7aee0f5cf991a32d78ed59f`. Runtime-only copies of the actual bundles and per-stage source hashes were retained. Thirteen initial v1 retrievals remain explicitly excluded because of the harness request-object/tokenizer wiring error described above. That failed probe had no answer or judgement and did not change the read-only corpus.

A subsequent zero-paid-call probe replayed the structured arm's native candidates through the actual internal core hybrid fusion, verified every reconstructed original excerpt against its trace hash, and compared its five visible hits against the unchanged local MiniLM reranker on the current original question. The union of five-per-search annotated-source recall was 0.30648 under RRF and 0.32870 under local reranking; the full internal-pool union was 0.46574. The sole visibility improvement was `10m_9_q_2`, whose required sources were already covered by the final answer context. No new final-source coverage or QA gain is established, so internal reranking was not implemented as another default. This probe supplied no labels to the scorer and does not count as an additional scored ablation.

The next independent experiment is a local reranker-model comparison on exactly frozen candidates, using the existing cross-encoder interface rather than another planner-prompt tweak. Flash models/providers, corpus, candidate texts, Top-12, 512-token pair limit and official prompts will remain fixed. The Transformers.js-compatible `Xenova/bge-reranker-base` model has the expected sequence-classification interface and quantized ONNX artifact ([model card](https://huggingface.co/Xenova/bge-reranker-base)); its public revision was verified as `280bcc27a84e0b898c251e06fddb25171bd9b101`. Compatibility and runtime performance must be verified before scoring or claiming improved quality. No default model has been changed, no work has been pushed, and the complete-200 score-above-0.5 gate is still unmet.


### Local cross-encoder model diagnostic (in progress)

The existing `LocalTransformersReranker` and CLI model option can load a different sequence-classification model without changing core ranking code. The independent diagnostic under `outputs-beam10m-bge-reranker-ablation-20261005/beam` compares `Xenova/bge-reranker-base` with the completed twenty-question MiniLM control (QA 0.25625), on exactly its frozen original fused candidates. It changes the model **and its tokenizer**, not just classifier weights. Candidate order/text, user scopes, Top-12, q8, batch eight, numeric 512-token pair limit, Flash models/providers and official prompts remain fixed. No fresh planner calls, ingestion, context-window repair or default model changes are made.

The model passed a real positive/negative pair smoke. Direct Hugging Face download timed out; the existing mirror download route succeeded. All four used cache artifacts were checked against the pinned public revision `280bcc27a84e0b898c251e06fddb25171bd9b101`, using Git-blob hashes for small config files and published LFS SHA256 for the tokenizer and ONNX weights. Verified weight SHA256 is `dd98f3e67837d23210a6b7550c08cced4f61845b940ac45be3565840a10f3244`; tokenizer SHA256 is `48564c5c7d3fa64d85d95e65414a542385f88b0f128fd8d4163fd7a57f2be05c`. The comparison uses a frozen local-only cache, so the download mirror does not change any answer/judge provider or artifact identity.

All twenty rankings completed with exact control-context replay and original scoring-text hash checks. CPU scoring took roughly 7–11 seconds per question; the observed driver working set was about 1.7 GiB, a point-in-time observation rather than a measured peak. Answers/judgements are running with complete inputs only. No QA improvement or promotion is claimed before their full result, and the full-200 score-above-0.5 gate remains unmet.
