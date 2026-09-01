# @melandlabs/benchmark-beam

BEAM (Benchmarking EffecTive Agent Memory, Tavakoli et al., ICLR 2026,
arXiv:2510.27246) runner for the OpenContext memory system.

BEAM is the post-2025 standard for long-term LLM-agent memory
benchmarks. Its 10 categories map **1:1 onto OpenContext product claims** —
this runner exists to make that case airtight for the investor deck.

## Why BEAM (vs LoCoMo / LongMemEval / CLBench)

| Benchmark   | Year     | Question types | Scoring              | Verdict      |
| ----------- | -------- | -------------: | -------------------- | ------------ |
| LoCoMo      | 2024     |              6 | binary               | outdated     |
| LongMemEval | 2024     |              6 | binary               | outdated     |
| CLBench     | 2024     |              4 | F1                   | outdated     |
| **BEAM**    | **2026** |         **10** | **nugget (0/0.5/1)** | **standard** |

BEAM is also the most-cited agent-memory benchmark of 2025–2026.
SOTA numbers are tracked at the BEAM leaderboard (see paper §6).

## OpenContext × BEAM claim mapping

Each BEAM category is wired to a specific OpenContext product claim in
`src/scorer.ts → OPENCONTEXT_CLAIM_MAP`. The CLI prints this mapping in the
per-category summary table.

| BEAM category                | What it tests                           | OpenContext claim                                               |
| ---------------------------- | --------------------------------------- | ----------------------------------------------------------- |
| **abstention**               | "Knows when NOT to answer"              | **Active forgetting** — the system knows when NOT to answer |
| **contradiction_resolution** | Reconciles conflicting prior statements | **Cross-session attribution**                               |
| **event_ordering**           | Sequences events correctly              | Cross-session attribution                                   |
| **information_extraction**   | Pulls a specific fact                   | Long-term recall                                            |
| **instruction_following**    | Honors user-stated rules                | User-defined rules & commitments                            |
| **knowledge_update**         | Refreshes stale memory with new info    | **Active reinforcement** — update stale memory              |
| **multi_session_reasoning**  | Combines info across distinct sessions  | **Cross-session attribution**                               |
| **preference_following**     | Tracks user preferences over time       | **Knows you better over time**                              |
| **summarization**            | Compresses long contexts                | Long-context compression                                    |
| **temporal_reasoning**       | Dates, durations, ordering              | Time-aware retrieval                                        |

For deck / blog demos, run the **OpenContext highlight subset** with
`--type knowledge_update,preference_following,contradiction_resolution,multi_session_reasoning`.
That covers 4 of the 5 headline claims in one shot.

## File layout (mirrors longmemeval)

```
benchmark/beam/
├── package.json
├── tsconfig.json
├── .env.example                # OPENCONTEXT_URL / ANTHROPIC_* / OPENROUTER_API_KEY
├── .gitignore                  # ignores results + beam_*.json
├── README.md                   # ← you are here
├── src/
│   ├── types.ts                # BeamConversation / BeamProbingQuestion / 10-category union
│   ├── contracts.ts            # VERBATIM copy of longmemeval/src/contracts.ts
│   ├── dataset.ts              # JSON loader + scale/type/conversation filtering
│   ├── prompts.ts              # BEAM_NUGGET_JUDGE_PROMPT (rubric + 1-shot)
│   ├── metrics.ts              # evaluateNuggetJudge + calculateNuggetCategoryMetrics
│   ├── diagnostics.ts          # source/chunk/retrieval/model-call diagnostic chain
│   ├── scorer.ts               # 10-type map + OPENCONTEXT_CLAIM_MAP
│   ├── opencontext-client.ts   # VERBATIM copy of longmemeval/src/opencontext-client.ts
│   ├── evaluator.ts            # BeamEvaluator — chunked ingest (20 turns) + nugget judge
│   └── index.ts                # CLI (--scale / --type / --conversations / --questions-per-conv)
└── dataset/
    ├── README.md
    ├── convert.py              # pyarrow → JSON (one file per scale)
    └── sample_conversation.json
```

## Architecture (what differs from longmemeval)

| Concern            | LongMemEval                           | BEAM                                              |
| ------------------ | ------------------------------------- | ------------------------------------------------- |
| Data format        | JSON                                  | parquet → JSON (via `dataset/convert.py`)         |
| Scale              | 1 (~115K)                             | **4 buckets**: 128K / 500K / 1M / 10M             |
| Conversation size  | Multi-session arrays, ~50 turns total | Single chat, **avg 842 turns @ 1M / 7,757 @ 10M** |
| Scoring            | binary CORRECT/WRONG                  | **nugget 0.0/0.5/1.0 per atom**                   |
| Judge              | 1 binary prompt                       | **rubric + 1-shot** (`BEAM_NUGGET_JUDGE_PROMPT`)  |
| Ingest             | 1 memory message per session          | **20 turns per memory message**                   |
| Resume             | Reuse all completed results; retry execution failures | Reuse completed judge results; retry errors |
| Per-question score | `correct: bool`                       | `nugget_mean + nugget_pass (≥0.5)`                |

## CLI

Copy `.env.example` to `.env` and configure the provider before running a paid
evaluation. A low-cost domestic Flash pairing is:

```dotenv
ANTHROPIC_AUTH_TOKEN=
OPENROUTER_API_KEY=your_openrouter_api_key_here
OPENROUTER_ANSWER_MODEL=deepseek/deepseek-v4-flash-0731
OPENROUTER_JUDGE_MODEL=qwen/qwen3.7-flash
```

`OPENROUTER_JUDGE_MODEL` is required and controls the actual nugget-judge call;
it is not fixed in code. If `ANTHROPIC_AUTH_TOKEN` is set, the Answerer instead
uses `ANTHROPIC_BASE_URL` and `ANSWER_MODEL`.

```bash
# Show help
pnpm --filter @melandlabs/benchmark-beam benchmark -- --help

# Offline data-preparation smoke (no credentials or HF download)
python dataset/convert.py --scale sample

# Local evaluation smoke (requires daemon + provider credentials; incurs model calls)
pnpm --filter @melandlabs/benchmark-beam benchmark -- \
  --dataset dataset/sample_conversation.json

# Full 1M run (requires converted JSON — see dataset/README.md)
pnpm --filter @melandlabs/benchmark-beam benchmark -- \
  --dataset dataset/beam_1m.json \
  --output results/beam_1m_$(date +%Y%m%d_%H%M%S).json

# OpenContext claim subset, 5 conversations (good for blog demo)
pnpm --filter @melandlabs/benchmark-beam benchmark -- \
  --dataset dataset/beam_1m.json \
  --type knowledge_update,preference_following,contradiction_resolution,multi_session_reasoning \
  --conversations 5
```

### All CLI flags

| Flag                             | Description                                         |
| -------------------------------- | --------------------------------------------------- |
| `-d, --dataset <path>`           | (required) BEAM JSON dataset path                   |
| `-c, --conversations <n>`        | Cap conversations (default: all)                    |
| `-qpc, --questions-per-conv <n>` | Cap questions per conversation (default: all)       |
| `-t, --type <csv>`               | Filter categories (csv of the 10 names)             |
| `--scale <128k\|500k\|1m\|10m>`  | Validate dataset scale tag                          |
| `--quick`                        | First 5 questions only                              |
| `--resume` / `--no-resume`       | Reuse cached judge results (default: resume)        |
| `-p, --port <n>`                 | OpenContext memory daemon port (default: 7421, env: `OPENCONTEXT_PORT` / `OPENCONTEXT_URL`) |
| `-o, --output <path>`            | Write results JSON to this path                     |

Before ingest or model calls, the CLI checks the dataset and filters, daemon,
credentials, output/checkpoint paths, and arguments. It reports all detected
failures together and never prints credential values. `--help` does not run
these checks. `--resume` reuses completed judge results regardless of pass/fail
only when the Answerer/Judge identities and normalized conversation fingerprint
match the current run;
`--no-resume` ignores existing checkpoints.

Converted datasets must be regenerated after this diagnostic-chain change so
the JSON retains upstream turn ids and `source_chat_ids`. Legacy checkpoints
with an older `trace_schema_version` are ignored because they cannot provide the
same evidence chain.

## Output JSON shape

```jsonc
{
  "dataset": "dataset/beam_1m.json",
  "scale": "1m",
  "conversations_run": 35,
  "questions_run": 700,
  "categories_filter": null,
  "token_usage": { "prompt_tokens": 1000, "completion_tokens": 200, "total_tokens": 1200 },
  "run_manifest": { "schema_version": 1, "git_commit": "...", "wall_clock_ms": 12345, … },
  "diagnostics": {
    "mean_source_recall_at_k": 0.71,
    "mean_retrievable_source_recall_at_k": 0.74,
    "hit_at_k_rate": 0.82,
    "mean_reciprocal_rank": 0.64,
    "failure_stages": { "retrieval_miss": 12, "context_present_answer_failed": 8 }
  },
  "diagnostic_artifacts": {
    "trace_schema_version": "1.1",
    "trace": "results/beam_1m.trace.jsonl",
    "chunks": "results/beam_1m.chunks.jsonl"
  },
  "summary": {
    "count": 700,
    "nugget_mean": 0.62,
    "nugget_pass_count": 432,
    "nugget_pass_rate": 0.617,
    "abstention_count": 38
  },
  "per_category": {
    "abstention":          { "opencontext_claim": "Active forgetting…",  "nugget_mean": 0.81, … },
    "knowledge_update":    { "opencontext_claim": "Active reinforcement…", … },
    "preference_following":{ "opencontext_claim": "Knows you better…", … },
    …
  },
  "per_entry": [
    { "entry_id": "abc123", "scale": "1m", "total_questions": 20, "correct_answers": 13, "nugget_mean": 0.61, … }
  ],
  "predictions": [
    {
      "question_id": "abc123_q1",
      "category": "knowledge_update",
      "scale": "1m",
      "atoms": ["The user now lives in Berlin", "Job is at a fintech"],
      "nugget_scores": [1.0, 0.5],
      "nugget_mean": 0.75,
      "nugget_pass": true,
      "judge_reasoning": "Both atoms are present…",
      …
    }
  ]
}
```

Provider usage is recorded when returned; unavailable values are `null`, never a
fabricated zero. With `--output results.json`, the same manifest is also written
to `results.json.manifest.json`; without `--output`, it is written under
`results/`.

When `--output` is set, the runner also writes:

- `*.chunks.jsonl`: upstream turn ids → deterministic chunk/message id → exact
  ingest batch and status.
- `*.trace.jsonl`: conversation id/fingerprint, gold source ids (required,
  available, missing, retrieved and missed), full ranked Top-K contents and
  daemon score signals, exact Answerer/Judge prompts, model responses, timing,
  usage, Judge raw/parse status, answer attribution, and a conservative failure
  stage.

The source mapping is diagnostic only. Questions without an upstream source id
remain scoreable, but retrieval metrics are marked unavailable rather than
inventing a gold mapping. Dataset-source coverage is reported separately so a
bad upstream reference is not silently blamed on OpenContext retrieval.

The diagnostic fields do not participate in scoring. Existing
`nugget_scores`, `nugget_mean`, and `nugget_pass >= 0.5` behavior is unchanged.

## Smoke-test checklist

```bash
# 1. Install deps
pnpm --filter @melandlabs/benchmark-beam install

# 2. Start the OpenContext memory daemon (from repo root, after build)
node packages/opencontext/dist/cli/opencontext.js http \
  --embedding-provider local --memory-backend sqlite-vec
#    (or `opencontext http` if the global bin is installed; default http://127.0.0.1:7421, no auth)

# 3. Generate sample (offline, no HF download)
python dataset/convert.py --scale sample

# 4. Run the local evaluation smoke (this uses configured paid model providers)
pnpm --filter @melandlabs/benchmark-beam benchmark -- \
  --dataset dataset/sample_conversation.json \
  --output results/sample_run.json
# → exits 0, ingests chunk messages via POST /v1/raw-messages to the daemon
# → results JSON contains summary.nugget_mean + summary.nugget_pass_rate

# 5. Re-run with --no-resume to force fresh eval
pnpm --filter @melandlabs/benchmark-beam benchmark -- \
  --dataset dataset/sample_conversation.json \
  --no-resume --output results/sample_rerun.json

# 6. Re-run with default resume; verify checkpoint hit
pnpm --filter @melandlabs/benchmark-beam benchmark -- \
  --dataset dataset/sample_conversation.json
# → should log "[BEAM] Resuming from checkpoint for sample_001_q1"
```

## Cost & wall-clock (estimate)

| Scale  | Convos |  Qs | Wall clock |      $ |
| ------ | -----: | --: | ---------: | -----: |
| sample |      1 |   1 |     <1 min | ~$0.02 |
| 128k   |     20 | 400 |      1–2 h |    ~$5 |
| 500k   |     35 | 700 |      3–5 h |   ~$15 |
| 1m     |     35 | 700 |      5–9 h |   ~$25 |
| 10m    |     10 | 200 |     8–15 h |   ~$40 |

Actual cost depends on `OPENROUTER_JUDGE_MODEL` and the configured Answerer
(Anthropic-compatible endpoint when `ANTHROPIC_AUTH_TOKEN` is set; otherwise
`OPENROUTER_ANSWER_MODEL`). The table is only a rough planning estimate. Judge
retries are bounded at 3 attempts.

## Critical risks (acknowledged in design)

1. **10M retrieval**: 3,880 chunk messages per conversation, but the
   answerer only sees the top 8 `POST /v1/search` hits — headline numbers
   depend on embedding retrieval quality.
2. **Atoms may be empty**: `evaluateNuggetJudge` returns
   `{ scores: [], reasoning: "no atoms" }` — we record
   `nugget_mean: 0, nugget_pass: false` and warn, never crash.
3. **Ingest concurrency**: 10M ingests 38,800 memory messages. The runner
   is sequential today; parallelize via `--write-concurrency` (TODO).
4. **Judge variance**: BEAM rubric is fuzzy enough that the same answer
   can score 0.5 or 1.0 from different judges. The 1-shot example
   reduces (but doesn't eliminate) this. For headline numbers, run
   N=3 and take the median.

## Reference

- Paper: Tavakoli et al., "BEAM: Benchmarking EffecTive Agent Memory",
  ICLR 2026. arXiv:2510.27246.
- Datasets: <https://huggingface.co/datasets/Mohammadta/BEAM> (`128k`, `500k`,
  `1m`) and <https://huggingface.co/datasets/Mohammadta/BEAM-10M> (`10m`)
- Leaderboard: see paper §6.
