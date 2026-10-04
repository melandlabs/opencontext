# BEAM 10M: pinned-provider iterative-union final report

## Result and comparison

The complete iterative-union run scored **0.2844167 over 200 questions**, compared with **0.2462462** for the complete query-rewrite run. The difference is **+0.0381705**, not a demonstrated score above 0.5. Both runs completed 200 retrievals, 200 answers and 200 judgements; neither result treats failed questions as zero.

| Measure | Query rewrite | Iterative union |
| --- | ---: | ---: |
| Mean official judge score | 0.2462 | 0.2844 |
| Perfect / partial / zero scores | 42 / 22 / 136 | 50 / 19 / 131 |
| Mean annotated-source Recall@12, 176 questions | 0.3423 | 0.3451 |
| Questions with all annotated sources / no annotated source | 36 / 77 | 38 / 81 |
| Degraded reasoning traces | 4 | 136 |
| Reranker-enabled traces | 200 | 200 |

The score is a mean rubric score, **not a binary pass rate**. Perfect-score frequency is 25% for iterative union. Across the same 200 questions, 29 scores improved, 28 worsened and 143 were unchanged. Annotated-source recall improved on four questions, worsened on six and was unchanged on 166.

Most of the aggregate score gain came from abstention: 0.45 to 0.80 contributes 0.0350 to the overall mean. Excluding abstention, the remaining 180 questions averaged approximately **0.2236 versus 0.2271**. This is not evidence of a large general memory-reasoning improvement.

## Frozen experiment identity

- Branch: `experiment/beam10m-iterative-recall`; frozen run commit: `897656dce67cd44aadc4d46e4446098529bff4d9`.
- Tag: `beam10m-pinned-union-hybrid-rrf-20261003`; finished on 2026-10-04.
- Artifact directory: `D:/opencontext-iterative-recall/benchmark/aml-local/outputs-beam10m-pinned-union-hybrid-rrf-20261003/beam`.
- Dataset SHA256, independently verified after completion: `f80b3ca1236c6933300cd89cc65f1062535b18ca86c733eb34a73309e8439978`. The generated run manifest itself has a null dataset hash; this independent hash must not be described as a manifest field.
- Reused ingestion database: `beam10m-retrieval-experiments-20261001.db`, with 39,920 committed Add batches and 416,437 embedded search children. Individual messages remain separate parents; Add batching does not create a twenty-turn parent message.
- Planner and answer model: `deepseek/deepseek-v4-flash-0731`, pinned to **OpenInference**, reasoning disabled.
- Rubric judge and event-equivalence model: `qwen/qwen3.8-flash`, pinned to **Alibaba**, reasoning disabled. Provider fallbacks were disabled.
- Embedding: `Xenova/all-MiniLM-L6-v2`, fp32. Local reranker: `Xenova/ms-marco-MiniLM-L-6-v2`, q8, batch size eight, 512-token pair limit.
- Top-12 is the user's local override of the public Top-100 setting. This resumed, reused-database experiment is a local diagnostic comparison, not a fresh official leaderboard submission.

The vendored official question rendering, judge prompts, rubric parser and event metrics were used without experiment-specific changes. The three repaired core defects are shared with the rewrite branch: monotonic BM25 relevance conversion, preservation of partial vector results with bounded user-scoped fallback, and preservation of multiple matched spans during parent fusion. The fourth issue, reranker input truncation and context-window construction, remains deferred.

## Runtime and provider verification

All 200 successful answer responses reported OpenInference. All 590 successful judge subrequests reported Alibaba. There were zero successful-provider mismatches. One answer attempt (`10m_4_q_12`) reached the initial 512-token limit; two rubric attempts (`10m_2_q_5`, `10m_5_q_5`) reached the initial 1,024-token limit. Bounded recovery completed all three questions. No questions remained pending.

For the 200 successful answers, native provider usage reported mean input **8,392 tokens**, median **8,313**, nearest-rank P95 **12,360**, maximum **14,821**; mean output **41.2**, maximum **276**, and zero reasoning tokens. These are provider-reported units, not the ingestion chunker's estimated tokens. Planner routing was enforced in the core callback, but planner calls do not have the same per-request audit artifact as answer/judge calls; the 136 degraded traces cannot be attributed to a particular failure cause from the existing trace alone.

The manifest's approximately 47-minute wall time covers the final resumed invocation, not the entire experiment across pauses. Event-equivalence requests explain why one event-ordering question can remain active for minutes while its request count increases; that alone does not establish an infinite retry loop.

## Categories

Each category contains twenty scored questions. Abstention has no source annotations; summarization has sixteen annotated questions, and the other categories have twenty.

| Category | Rewrite score | Union score | Union source Recall@12 |
| --- | ---: | ---: | ---: |
| Abstention | 0.4500 | 0.8000 | N/A |
| Information extraction | 0.5500 | 0.6500 | 0.7500 |
| Knowledge update | 0.5000 | 0.5500 | 0.6858 |
| Preference following | 0.4375 | 0.3750 | 0.2583 |
| Instruction following | 0.3125 | 0.2875 | 0.1250 |
| Contradiction resolution | 0.0438 | 0.0563 | 0.5888 |
| Multi-session reasoning | 0.0750 | 0.0500 | 0.3433 |
| Summarization | 0.0092 | 0.0400 | 0.0238 |
| Temporal reasoning | 0.0250 | 0.0250 | 0.2542 |
| Event ordering | 0.0595 | 0.0104 | 0.0124 |

Event ordering did not improve: nineteen questions scored zero and one had a partial score. Temporal reasoning remained poor. A higher overall score must not be presented as improvement in these categories.

## Evidence chain and ranking ablations

| Stage, 176 annotated questions | Mean source recall | Any required source | All required sources |
| --- | ---: | ---: | ---: |
| Available in the indexed corpus | 1.0000 | 176 | 176 |
| Candidate-channel union | 0.4723 | 126 | 58 |
| Fused candidate pool before reranking | 0.4125 | 113 | 48 |
| Final Top-12 | 0.3451 | 95 | 38 |

All required source turns existed in the indexed corpus. Thirteen questions lost their last annotated source at fusion and eighteen more at final ranking/truncation. The keyword candidate channel had mean source recall 0.3165, semantic candidates 0.3839, and planner evidence 0.1858. Entity candidates were zero: `entitySearch` is an unwired optional host dependency, not an environment switch. Insights/knowledge were not populated or searched in this raw-message experiment.

At the same Top-12 budget, keyword order achieved source recall **0.2258**, semantic order **0.2637**, fused order **0.2998**, and final reranked order **0.3451**. Thus the aggregate evidence does not support disabling the reranker. There were 737 final hits with multiple matched spans, and four final hits used exact user-scoped vector fallback. These counts demonstrate executed paths, not proof that every answer-bearing sentence was shown.

The canonical JavaScript RRF counterfactual replayed all 200 traces with zero ranking mismatches. For 176 annotated questions, pre-rerank Recall@12 was **0.29983 with planner evidence versus 0.30129 without it**. This isolates channel fusion only, not final reranking or QA. The Python approximation differs on three tie-breaks and is not substituted for this exact replay. A later shared repair prevents source-chunk ID array mutation during fusion; the frozen run predates it, so exact per-channel child attribution needs that caveat.

Source-turn IDs establish parent retrieval, not visibility or use of the correct child span. This distinction remains necessary even with complete trace files.

## Cases that distinguish retrieval from answer failure

- `10m_9_q_6`: the album source was returned at rank one. The union answer correctly said **50 pages, $75**, whereas the rewrite answer addressed a historical photo-selection question.
- `10m_9_q_13`: both annotated sources were returned at ranks one and six, but the answer still said the combined island duration could not be determined. The visible excerpts allocate 1.5 and 2 hours, supporting 3.5 hours. Retrieval alone did not fix answer interpretation.
- `10m_1_q_3`: both annotated sources occupied ranks one and two, yet the answer was only **"No."** and received zero. The rubric asks for an explained contradiction/clarification. The source statements also warrant the ambiguity caution documented in the rewrite report.
- `10m_3_q_19`: source recall increased from 0.5 to 1.0, but the answer was **0** and received zero. The retrieved text gives testing on January 21 and deployment setup on February 1, 2025. That is eleven elapsed days or twelve dates counted inclusively; the rubric requires twelve. This is an interpretation and rubric-convention issue, not justification for hardcoding a gold number.

## Completed core follow-up ablations

All use the same fixed twenty IDs: two per category selected by lowest SHA256 of question ID, independently of answers and rubrics. They use the same Flash models and fixed providers and keep official prompts unchanged. Small-subset scores are not substitutes for a full 200-question confirmation.

1. **Structured planner chat roles:** the existing core fix preserves actual system/user/assistant roles instead of placing a flattened transcript into one user message. The matched subset scored **0.2500 versus 0.2250** in the frozen flat-history union run: two improvements, one regression and seventeen unchanged. Twelve traces were still degraded. A real-CLI protocol smoke completed search -> note -> finish. This supports the transport correction, but not a large or statistically established full-run gain.
2. **Wider fused rerank window:** actual frozen and modified core implementations were replayed on identical candidates. Baseline Top-12 IDs and full answer contexts were reconstructed exactly for all twenty questions. Increasing the pre-rerank window from 48 to approximately 70-101 candidates changed annotated-source recall **0.3750 to 0.3630** and QA **0.2250 to 0.2188**. Two scores improved, one worsened and seventeen were unchanged. The wider default was withdrawn; the compiled prototype and manifests remain in ignored local artifacts.
3. **Deduplicate lexical terms before the sixteen-term cap:** a minimal core change preserves Unicode, numbers, negation terms and first-occurrence order; it adds no dataset-specific stopword rules. Original FTS5 order/content and original final contexts were verified against the frozen run. The semantic and planner candidates, fusion window, local reranker and Top-12 were held fixed. All eighteen annotated questions retained identical source recall, mean **0.3750**. QA was **0.2438 versus 0.2250**, but all gain came from two questions whose full retrieved contexts were byte-for-byte unchanged. Four questions had changed contexts; their scores did not change. Therefore **no answer-score gain is attributed to keyword deduplication**. Twenty answer calls reported OpenInference and fifty successful judge calls reported Alibaba.
4. **Remaining-action budget hints:** a core-only prompt prototype was compared with a fresh control using the same structured roles, lexical deduplication, four-action limit and fixed twenty question IDs. Both completed all retrievals, answers and judgements. Degraded/no-note traces fell from **11 to 1**, with zero completion errors in both runs; planner-channel source recall rose from **0.1389 to 0.2454**. However, final source Recall@12 remained **0.3750 on every paired annotated question**, and QA fell from **0.25625 to 0.18125**: one improvement, two regressions and seventeen unchanged. Seventeen full answer contexts changed; the three unchanged contexts had unchanged scores. The regressions were `10m_2_q_15` and `10m_5_q_10`, each 1.0 to 0.0; `10m_4_q_8` improved from 0.0 to 0.5. Twenty answer calls reported OpenInference and fifty successful judge subrequests reported Alibaba, with no failed attempts or provider mismatches. **The default budget hints were withdrawn.** Improved protocol compliance alone does not demonstrate better answers; this negative subset result does not establish the size of a full-run regression.

The budget prototype was frozen at commit `8b8bfa9b3217d9cd097cf6650d2b084a410d9a18`; its CLI bundle SHA256 was `409ee6983150e9bc21169edbb267003de1ac76e177feb2ba2d18119bae1e665b`. The compiled CLI and manifest remain in ignored local artifacts under `outputs-beam10m-planner-budget-ablation-20261004`. The later source withdrawal does not alter its completed artifacts. The opt-in bounded action ledger remains, with a regression test confirming that enabling diagnostics does not change planner prompts or selected evidence.

The lexical replay initially used Node's bundled SQLite 3.51.2, which chose a slow user-first nested FTS scan. It was restarted, before producing a scored result, with the actual production `better-sqlite3` driver, SQLite 3.53.4. Both corpus and SQL were unchanged. Four previously unseen parent IDs were mapped with the unchanged adapter's `beam_source_ids` helper; no sequence-number-to-source-ID guess was used.

## Next optimization priorities

1. Establish **why iterative planning degraded**, especially the 100 traces with four iterations, five fallback candidates and a degraded marker. The frozen full-run records do not distinguish unparseable actions, request failures and failure to commit evidence. A later opt-in core action ledger was exercised on the same twenty selected questions with structured roles and deduplicated lexical terms: eleven degraded because no evidence was noted, zero completion requests failed, and only one action was unparseable. This fresh diagnostic does not retroactively establish the cause of all 136 frozen-run degradations. The completed budget-awareness ablation above shows that reducing this degradation marker is not sufficient: prioritise useful new evidence and its survival through final ranking, rather than only increasing the number of note actions.
2. Improve coverage for broad questions through general, evidence-linked retrieval or summary capabilities. Event questions require a mean of 37.95 annotated turns; nineteen require more than twelve. The ideal Top-12 parent-source recall ceiling averages 0.4314, not a QA ceiling. Raw parent retrieval alone is an unsuitable basis for claiming complete timeline coverage.
3. Address answer interpretation where exact text is already visible. The failed context-quoting diagnostic in the rewrite report shows that a plausible formatting change cannot simply be assumed beneficial. Any replacement belongs in core evidence presentation and needs its own matched experiment.
4. Keep the useful core correctness repairs, provider checks and complete evidence traces. Reject unproved ranking changes and distinguish replay/subset diagnostics from full-run results. The deferred cross-encoder truncation issue remains explicitly outside this round.

## Final code and handoff state

The shared post-run correctness fixes and diagnostics were synchronized to both experiment branches after preserving the frozen iterative CLI and search bundle. Default wider reranking and planner-budget hints are absent. Structured planner chat transport, immutable matched-evidence provenance, lexical-term deduplication and opt-in action diagnostics remain. The two original complete scores belong to their frozen run commits, **not to a new complete evaluation of these later changes**.

Scoped verification covered 109 TypeScript tests across retrieval, provenance, CLI reasoning transport and SQLite child retrieval, 24 Python adapter/analysis/ablation tests, and three native replay tests. Both worktrees' memory-store and opencontext packages built successfully and passed their relevant type checks. The initial iterative-worktree opencontext type check saw a stale dependency declaration; rebuilding memory-store regenerated its exported types, after which the check passed. No full CI suite was run.

All test stages finished. The test-owned core and adapter services were stopped; corpus databases, checkpoints, provider logs and frozen experiment bundles remain in ignored local artifacts. Both local experiment branches contain the same final shared source repairs and these two English reports. A score above 0.5 was not demonstrated, and no default ranking/prompt change is presented as an established score gain. Further work should target the coverage and answer-interpretation gaps above rather than continue tuning this small subset.

Only the rewrite and iterative final reports are retained for these experiments. No experiment code, report or artifact has been pushed.

## Subsequent optimization continuation

The user subsequently made a complete score **above 0.5** an explicit completion requirement. The optimization goal is active again; the completed comparisons above are evidence, not satisfaction of that new gate.

A new opt-in core experiment performs query-conditioned **verbatim evidence selection after Top-12 ranking**. It does not change candidate retrieval, cross-encoder inputs, ranking, source IDs, official question/judge prompts or the persisted corpus. Each passage must match a unique substring of an original retrieved span; its UTF-16 offsets and original evidence remain available for audit. Unknown sources, invented/paraphrased passages, malformed output and oversized requests retain the original evidence instead. This is an unproven prototype, not an enabled default or a demonstrated score gain.

The first matched experiment replays the fresh twenty-question diagnostic control, verifies every original full answer context exactly, then changes only the core-produced excerpts. Selection calls are pinned to DeepSeek Flash/OpenInference with reasoning disabled; normal answer and judge stages use the existing pinned providers. The experiment is running under `outputs-beam10m-extractive-evidence-ablation-20261004`. Small-subset results, including any score above 0.5, will not satisfy the complete-200-question gate.

A separate numerical audit found 299 keyword candidate scores rounded to 1 across the original two-hundred-question rewrite traces. This is a precision risk, but the single lexical channel uses stable sorting and preserves database order on ties; it is **not established as a cause of the current failures**. No new BM25 score change was enabled on the strength of this count alone.

The extractive experiment completed all twenty context selections and answers and entered judgement. Its 67 selector requests reported DeepSeek Flash/OpenInference, with zero request failures, provider mismatches or reasoning tokens. Of 240 hit contexts, ninety had accepted original-text selections, forty-six retained the original because validation failed, and 104 were unchanged. Provider success does not imply quote-validation success. These are protocol/provenance measurements, not a completed QA-score result; Alibaba judge rate limits are being handled with bounded recovery.

A read-only adjacency audit motivates the next independent core experiment. Adding one preceding/following message within the same user, platform, bot, channel, person, episode, session and conversation increased **known-source coverage lower bound** from 0.3451 to 0.3890 across 176 annotated frozen-union questions, improving twenty. There were 2,820 neighbor visits without existing source mappings; no source IDs were guessed from sequence numbers. This hypothetical audit did not apply a context budget, perform new retrieval or produce answers. It is not a QA gain or a completed core ablation. A production implementation would need strict scope/lifecycle checks, bounded context, exact original-message provenance and separate direct-hit versus expanded-context measurements.

### Completed extractive-context ablation

All twenty answers and judgements completed. The score was **0.20000 versus the fresh diagnostic control's 0.25625**: zero questions improved, two worsened and eighteen were unchanged. `10m_7_q_10` fell from 1.0 to 0.0; `10m_9_q_2` fell from 0.125 to 0.0. Direct parent-source Recall@12 remained 0.375 on all eighteen annotated questions. All twenty answer calls reported OpenInference; all fifty successful judge subrequests reported Alibaba, with eight recovered failed attempts and zero successful-provider mismatches. No questions were skipped or assigned artificial zero scores. **The selector remains default-off and is not promoted.** This small negative diagnostic is not a complete-run score or an estimate of full-run regression.

### Independent original-dialogue context ablation

An opt-in core implementation now attaches an immediately preceding user message to an assistant hit, or an immediately following assistant message to a user hit. Both messages must match user, platform, bot, channel, person, episode and session/conversation/thread identifiers. The existing per-user sequence index is reused without reingestion or reembedding. Active/archive/deprecation, snapshot, bot and fact filters are enforced by the SQLite catalog; the ordinary retrieval date policy also applies to neighboring timestamps. Trusted graph-applicability or peer-scoped searches skip this catalog enrichment with a warning because it cannot enforce those additional authorization constraints. Missing timestamps remain absent.

Only final-ranked hits are supplemented. Reranker inputs, Top-12 anchor IDs, scores, relevance order and official AML prompts remain unchanged. A global additional-original-text budget of **16,000 UTF-16 characters**, not tokens, admits whole messages; oversized neighbors are omitted rather than silently truncated. Directly selected parents and previously attached neighbors are deduplicated. Separate original-message IDs, roles, sequences, optional timestamps and UTF-16 ranges are retained; stored upstream metadata cannot forge this derived context field.

The matched twenty-question ablation under `outputs-beam10m-dialogue-context-ablation-20261004` reproduced every control context exactly before intervention. It added 160 original neighboring messages, averaging 11,982.55 additional original characters per question. Each was verified against the read-only production-driver database. Source IDs were generated by the unchanged `beam_source_ids` adapter helper, not inferred from sequence values. Direct Recall@12 remains **0.37500**; expanded answer-context source recall is **0.43241**, improving three of eighteen annotated questions. Expanded-context coverage is **not** a new Top-12 retrieval score or proof of answer-bearing sentence use. The completed QA outcome is recorded below.

Core commit `5a58060` contains this default-off experiment on the iterative branch. Its SQLite catalog bundle SHA256 is `9aedd8f1758075234bcd681f0134a71540276fd649c6d3c7e4fb455ad92f80dd`; unified-search bundle SHA256 is `9d4bf3006aed32ccde4fcb3eb3b8b8181a7a786f9a74ac0cad146f7f93be7bb2`. Both were preserved in ignored frozen artifacts. After formatting the diagnostic harness, a separate unscored replay reproduced the exact twenty answer inputs: SHA256 `045cae9d0781f3945e956a2c46cc77b50ea68d5e3de0f9f71624b6ba23767902`. Original and reproduction manifests are retained, so the initial generation hash is not replaced by a later source hash.

The dialogue ablation subsequently completed **20/20 answers and 20/20 judgements**, with score **0.22083 versus 0.25625** for the fresh control. Three questions improved, two worsened and fifteen were unchanged. Increases were `10m_4_q_2` (0 to 0.125), `10m_4_q_8` (0 to 0.5) and `10m_10_q_14` (0 to 1/6); decreases were `10m_7_q_10` (1 to 0.5) and the abstention question `10m_10_q_1` (1 to 0). All twenty answer responses reported OpenInference; all fifty successful judge subrequests reported Alibaba, with zero failed attempts or provider mismatches. No questions remained pending. **Dialogue expansion remains default-off.** More context and higher parent-source coverage did not establish better QA.

Scoped checks passed 22 SQLite tests, including a real read-only catalog, and 48 memory-store tests covering both search entry points and unchanged cross-encoder inputs. Relevant SQLite, memory-store and opencontext type checks passed; dependency/core packages built successfully. This is not full CI or a completed full-scale benchmark. The complete-200-question score-above-0.5 goal remains active, and nothing has been pushed.

The next independent retrieval experiment compares the existing original-first, one-variant user-voice rewriting with an opt-in original-first, three-variant evidence-expression rewriter. It targets facts and relevant historical requirements without generating answers or assumed dates. Only core retrieval prompts change; official AML answer and judge prompts do not. The additional variants and cost are part of the module being tested, not an isolated wording-only comparison. Fresh control retrieval is required because later shared correctness fixes must not be misattributed to the new expressions.

The fresh user-voice control and evidence-expression arm subsequently completed twenty answers and judgements each, scoring **0.21250 and 0.23125**, respectively. Two question scores increased, one decreased and seventeen were unchanged. Source Recall@12 on eighteen annotated questions moved from **0.37222 to 0.37685**; one improved, one worsened and sixteen were unchanged. Each arm had twenty successful OpenInference answers, fifty successful Alibaba judge subrequests, twenty local-reranker traces and zero degraded rewrites or successful-provider mismatches. The control recovered one failed judge attempt. These are weak small-subset results, not a full-run gain; the rewrite final report records the paired cases. The experimental rewrite remains opt-in.

### Independent evidence-reranker prototype

The next diagnostic replaces only the scoring plug-in at the existing core reranker boundary. It uses fixed original fused candidates, exact original scoring text and unchanged Top-12/context construction. It does not change retrieval, corpus contents, official AML prompts or the local cross-encoder's 512-token setting. DeepSeek Flash/OpenInference scores the candidates with reasoning disabled. Gold sources, rubrics and previous answers are excluded from model requests; annotations are used only after ranking for analysis. Every candidate must receive a validated integer score, and incomplete rankings remain pending rather than receiving artificial zero QA scores.

An initial replay rejected the reconstructed candidate order before any paid requests. Restoring the frozen fusion order instead of sorting by raw source similarity fixed that fixture error. The first long-ID scoring protocol then failed because some six-document batches returned only five scores. A new indexed-array protocol explicitly requests one score per document index and retains strict count/range validation. The old protocol's bundles, responses and successful checkpoint are preserved separately; none is presented as a completed QA result. The indexed protocol is being evaluated under `outputs-beam10m-llm-reranker-ablation-v3-20261004`. No default change or full-run score gain is claimed.

### Completed bounded pointwise-reranker ablation

The indexed protocol completed sixteen of twenty rankings; the same four questions remained invalid after one unchanged resume. All 144 first-pass HTTP responses used the required model/provider, stopped normally and reported zero reasoning tokens. Missing scores were a model-format problem, not established token truncation. Those rankings were not scored as zero.

Core recovery now bisects only an invalid scoring batch, ending at a strictly validated single document. Transport errors remain host-owned. One initial batch of N candidates requires at most 2*N-1 scoring calls; a malformed singleton still fails. There is no unlimited retry or fabricated score. The corrected diagnostic under `outputs-beam10m-llm-reranker-ablation-v4-20261004` replayed 144 frozen prior responses and made thirty additional OpenInference scoring requests, preserving every original candidate and text. The response-ledger hash is part of the manifest, and the exact scorer/search bundles and harness are frozen. This is a fixed-candidate diagnostic, not new retrieval or a fresh-ingestion formal submission.

All twenty rankings, answers and judgements completed. Mean QA score was **0.2920833 versus 0.2125000** for the fresh user-voice control: three improved, one worsened and sixteen were unchanged. Improvements were `10m_2_q_15` (0 to 1), `10m_3_q_4` (0 to 1/6) and `10m_10_q_14` (0 to 2/3); `10m_1_q_8` fell from 0.25 to 0. Source Recall@12 on eighteen annotated questions decreased from **0.37222 to 0.35926**: three improved, three worsened and twelve were unchanged. QA and annotated-source coverage do not move in lockstep, and these gains do not prove answer-bearing retrieval improvement for every changed score.

All twenty successful answer requests used DeepSeek Flash/OpenInference, and all 385 successful judge subrequests used Qwen Flash/Alibaba, with zero successful-provider mismatches. One rubric response was truncated at the official initial budget and recovered by bounded retry. The event-ordering answer listed twenty events, causing many official pairwise alignment calls; their continued growth was normal work, not a hung question. No questions were skipped. The optional scorer remains default-off, and the full-200 score-above-0.5 goal remains unmet.

An independent listwise variant now compares all forty-eight frozen fusion candidates together instead of comparing six-document batches by separately generated absolute grades. It returns a validated ranked prefix of twelve original indices; the core retains unselected originals in fusion order. Complete original text, roles, sequences and optional timestamps are preserved, with a bounded full-request budget of 256,000 UTF-16 characters, not tokens. Oversized requests fail before a paid call; no hidden clipping or extra gold evidence is allowed. The variant is being evaluated separately under `outputs-beam10m-listwise-reranker-ablation-20261004`. Forty-two scoped tests, relevant memory-store/opencontext type checks and the memory-store build passed. None of these checks is a completed listwise QA result or full CI.

The first two listwise attempts were interrupted after repeated malformed outputs, with their frozen code, responses and lone successful checkpoints retained. In some long requests the model continued quoted historical JSON or answered a historical message instead of selecting indices. Separating actual system/user roles alone did not resolve the observed behavior; it is not claimed to be a confirmed provider bug. The third attempt, under `outputs-beam10m-listwise-reranker-ablation-v3-20261005`, additionally places the current question and selection contract after the quoted documents. Tests verify the actual CLI transport forwards these roles with provider fallback disabled. No invalid selection from earlier attempts was passed to answer generation or judgement.

### Completed listwise diagnostic and full-scale confirmation

The third listwise attempt completed all twenty rankings, answers and judgements. Each ranking used one successful OpenInference call, averaging 8,862.4 ms of HTTP latency. All returned exactly twelve valid unique candidate indices, without format failures, provider mismatches or reasoning tokens. Mean QA score was **0.35000 versus 0.21250**: four improved, one worsened and fifteen were unchanged. Improvements were `10m_2_q_15` (0 to 1), `10m_4_q_8` (0 to 0.5), `10m_9_q_1` (0 to 1) and `10m_10_q_14` (0 to 0.5); `10m_1_q_8` fell from 0.25 to 0. All twenty answer requests used OpenInference and all fifty judge subrequests used Alibaba, with zero failed attempts or successful-provider mismatches.

Source Recall@12 decreased from **0.37222 to 0.33241** on eighteen annotated questions, with two improvements, four regressions and twelve unchanged. The higher small-subset QA score does not establish better annotated-source recall or a reliable full-run gain. The scorer remains opt-in and the complete-200 score-above-0.5 gate is still unmet.

A full two-hundred-question fixed-candidate confirmation has started under `outputs-beam10m-listwise-reranker-full200-20261005`, using the complete frozen iterative-union run as its retrieval control, not pretending that it shares the twenty-question rewrite control. Control score is 0.28442. The unchanged adapter generated canonical source mappings for all ten entries and 208,696 original messages. A read-only, zero-paid-call preflight verified all two hundred candidate sets against original parent/child hashes and scope; all full-pool requests fit the character budget, with a maximum of 162,182 characters. Each original complete answer context is also reproduced exactly before a ranking call. Ranking, answer and judge checkpoints remain separate; incomplete selections are never scored zero. This confirmation reuses corpus and frozen retrieval, not fresh ingestion or an official online submission. No complete score is available yet, and nothing has been pushed.

### Interpretation audit and full-ranking protocol recovery

All twenty listwise diagnostic contexts and Top-12 memberships changed relative to their matched fresh control. However, the improvement on `10m_2_q_15` is not discovery of a previously missing fact: the required 15% allocation was explicitly visible in both contexts. The control answer omitted it; the listwise answer used it. `10m_9_q_1` is an abstention question: the improvement is correct refusal to invent dolphin-watching factors, not annotated-source recall. The two abstention questions scored 0.5 in the fresh control and pointwise arm, and 1.0 in the listwise arm. The remaining eighteen questions scored 0.18056, 0.26898 and 0.27778 respectively. Thus most of the listwise-versus-pointwise difference on this small subset came from abstention. The full iterative control already scored 0.8 on its twenty abstention questions; extrapolating the small-subset gain would be misleading.

The first full ranking traversal preserved **188 valid selections**, with twelve pending questions and no answer/judge stage. HTTP 200 and the correct provider did not guarantee a valid selection: some outputs repeated indices or used indices outside the supplied pool. Native structured output was then added through the existing core completion callback and CLI transport, without changing official AML prompts. The host requires compatible parameter support, keeps the same fixed provider, and independently validates count, integer range and uniqueness. A separate continuation revalidated 188 frozen accepted responses and obtained ten additional valid selections, reaching **198/200**. The two remaining questions, `10m_4_q_15` and `10m_8_q_9`, still repeated indices despite the requested schema. Provider-side schema support is therefore not treated as a uniqueness guarantee.

The optional core listwise scorer now recovers an invalid batch through at most twelve single-choice requests. Each uses the same complete original candidate pool, explicitly records prior choices, and restricts the allowed-index enum to remaining candidates. Local checks reject a repeated or unknown choice; no fabricated scores, arbitrary fill-ins or unlimited retries are permitted. Transport errors remain host-owned. Seventy scoped tests, relevant memory-store/opencontext type checks and the memory-store build passed; no full CI was run.

The corrected confirmation is running under `outputs-beam10m-listwise-reranker-full200-final-20261005`. It freezes the actual scorer/search/harness files, both response-ledger hashes and the 198 accepted-checkpoint proof. These 198 responses are replayed and revalidated; only the remaining questions need new ranking generations. This is explicitly a **mixed frozen-response continuation**, not 200 fresh native-schema calls or a separate schema-efficacy ablation. Corpus, original candidate texts, models, providers, Top-12 and official answer/judge prompts remain fixed. Answers and judgements start only after every selection passes validation. A complete score above 0.5 has not yet been established; the optimization goal remains active, and nothing has been pushed.

The corrected ranking stage has now completed **200/200**, with 198 replayed responses and fourteen new successful OpenInference requests: one request resolved `10m_4_q_15`; `10m_8_q_9` needed one invalid batch plus twelve validated single choices. All fourteen reported zero reasoning tokens and no transport failures or provider mismatches. The final ranked annotated-source Recall@12 is **0.26831 versus 0.34510** in the full frozen union control: ten annotated questions improved, thirty worsened and 136 were unchanged. This clear source-coverage regression is retained in the report; a completed QA score is still pending, so the twenty-question score is not promoted to a full-run gain.

Audit limitation: this run's frozen harness recorded the first ledger hash on every replay row, including the ten responses actually read from the additional ledger. The manifest hashes both ledgers and the validated-checkpoint proof, and exact question/prompt keys identify the response unambiguously; the frozen rows are not rewritten after the experiment. Future harness runs record the actual supplying ledger hash per replay. This correction does not change candidate selection or the running answer/judge stages.

The corrected confirmation has also completed **200/200 answers**, all from DeepSeek Flash/OpenInference, with zero reported reasoning tokens. One truncated answer attempt recovered successfully; no answers were skipped. Official judgement has started using Qwen Flash/Alibaba. At the first audit, 25 questions were saved and 127 successful judge subrequests had the required provider, zero errors and zero reasoning tokens. The higher subrequest count is expected for official event-alignment comparisons and is not equated with 127 completed questions. Judgement is still running; no partial mean is represented as the full-run score.
