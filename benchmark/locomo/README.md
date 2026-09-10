# LoCoMo Benchmark

OpenContext's local LoCoMo V2 evaluation harness. It measures answer quality with
the existing LoCoMo answer prompt, token-overlap metrics, and an LLM judge while
preserving a question-level evidence trail for ingestion, retrieval, answerer,
and judge stages.

This is an OpenContext-specific evaluation pipeline. Its scores are not directly
comparable to the Agent Memory Leaderboard's official CORRECT/WRONG pipeline.

## Evaluation boundary

For the recommended `dialog` mode, the benchmark converts each upstream LoCoMo
conversation session into exactly one `RawMessage` and sends it to
`POST /v1/raw-messages` with `embedOnInsert: true`. Dialog-turn identifiers such
as `D1:3` remain in the raw text for later evidence attribution.

After that boundary, the daemon owns all core memory behavior:

- chunking and parent-child relationships;
- embedding and indexing;
- semantic/lexical retrieval, fusion, and reranking;
- the final Top-K returned by `POST /v1/search`.

The benchmark does not pre-chunk, embed, insert derived retrieval records, alter
rankings, or replace daemon results. It only formats the returned Top-K with the
existing benchmark prompt, calls the configured answer model, and scores that
answer.

`observation` and `session_summary` remain available for exploratory comparisons,
but a formal raw-conversation run should use `dialog`.

## Dataset

Use the text-only `locomo_v2_minicpm.json` file from
[LoCoMo V2](https://github.com/BrianV1981/locomo-v2). Put it under `dataset/`
(dataset JSON files are intentionally ignored by Git).

The downloaded V2 MiniCPM file contains 10 conversation samples and 1,922 raw
QA rows. The harness retains 1,492 rows with usable `answer` values, including
the eight answerable category-5 rows; its remaining category-5 rows use the
separate adversarial-answer format and are outside this answer-and-judge path.
Its 834 image descriptions are stored beside their dialog turns as
`minicpm_caption`; the dialog mapper includes those descriptions in the same
source RawMessage as the corresponding text and turn ID. The loader validates
sample IDs, conversation objects, QA fields, category, and any optional evidence
arrays before ingestion.

LoCoMo V2 does not provide a QA-level `evidence` field. Consequently, exact gold
dialog-turn Recall@K, Hit@K, MRR, and Precision@K are recorded as `null` for V2;
they must not be inferred from the answer string. The complete daemon retrieval
trace is still retained. If an evidence-bearing LoCoMo-compatible file is used,
gold metrics are computed only from exact turn IDs present in the returned child
chunk text; parent metadata alone does not count as a hit.

## Configuration

From `benchmark/locomo`, copy `.env.example` to `.env` and configure the models:

```env
OPENROUTER_API_KEY=your_openrouter_api_key_here
OPENROUTER_ANSWER_MODEL=deepseek/deepseek-v4-flash-0731
OPENROUTER_JUDGE_MODEL=qwen/qwen3.8-flash
LOCOMO_TOP_K=8
```

An Anthropic-compatible answer endpoint remains supported through
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, and `ANSWER_MODEL`. When that token
is absent, the answerer uses OpenRouter. The judge always uses OpenRouter and
requires `OPENROUTER_JUDGE_MODEL`; no judge model is hard-coded.

## Start a clean daemon

Build the repository once, then start the benchmark-owned local daemon:

```powershell
pnpm build
./benchmark/locomo/start-daemon.ps1 -Port 7421
```

Without `-DatabasePath`, every launch creates a timestamped fresh SQLite database
under `benchmark/locomo/runtime/`. The script refuses to replace an existing port
listener, waits for `/health`, and writes `daemon.json` plus stdout/stderr logs.
To resume the exact same database deliberately:

```powershell
./benchmark/locomo/start-daemon.ps1 -Port 7421 -DatabasePath D:\path\to\store.db
```

The launcher uses local MiniLM embeddings, `sqlite-vec`, and the local MiniLM
reranker. The returned `daemon.json` freezes those settings for the run record.

## Preflight and run

Run commands from `benchmark/locomo`:

```powershell
# Validate dataset, daemon, credentials, arguments, and writable artifacts.
pnpm benchmark -- --dataset dataset/locomo_v2_minicpm.json --mode dialog --preflight-only

# Small smoke run: first five answerable questions per sample.
pnpm benchmark -- --dataset dataset/locomo_v2_minicpm.json --mode dialog --quick --no-resume --output results/smoke.json

# Formal full run against a fresh daemon database.
pnpm benchmark -- --dataset dataset/locomo_v2_minicpm.json --mode dialog --no-resume --output results/locomo-v2-dialog.json
```

Useful options:

- `--samples conv-26,conv-30` selects sample IDs.
- `--port 7421` overrides `OPENCONTEXT_PORT`/`OPENCONTEXT_URL`.
- `--resume` reuses only completed checkpoints whose schema, dataset, question,
  retrieval mode/Top-K, answer model, and judge model all match.
- `--no-resume` reruns every selected question. Use it with a fresh database for
  comparable formal results.
- `LOCOMO_CHECKPOINT_DIR` moves the checkpoint directory.
- `LOCOMO_MODEL_REQUEST_TIMEOUT_MS` configures answer/judge request timeout.

Execution failures are checkpointed separately and retried on a resumed run;
they are never counted as completed judge failures or retrieval-metric misses.

## Evidence artifacts

With `--output results/run.json`, the harness writes:

- `run.json`: compact results, category metrics, completed-only accuracy,
  execution-error rate, diagnostic summary, and run manifest reference;
- `run.trace.jsonl`: one complete record per QA, including exact dataset/question
  hashes, final Top-K full text, candidate channels, fused pre-rerank order,
  reranker metadata, answer prompt/response, raw judge output, attempts, latency,
  token usage, and failure-stage classification;
- `run.sessions.jsonl`: one record per mapped source session, including message ID,
  source evidence IDs, content hash/size, ingest batch, status, latency, warnings,
  and error details;
- `run.json.manifest.json`: Git state, dataset path/hash/size, models, retrieval
  configuration, selection flags, resume mode, timestamps, and token usage.

Candidate hits keep hashes and excerpts to limit artifact size; final Top-K hits
keep the full text actually supplied to the answer prompt. When the daemon does
not return pre-merge diagnostics, the trace says so explicitly instead of
inventing candidate-stage evidence.

## Metrics and failure attribution

The primary answer metric is LLM-judge accuracy. F1 and BLEU-1/4 are also
reported. Diagnostics keep these cases separate:

- ingestion/indexing, retrieval, answerer, judge, and provider execution errors;
- missing or partial dataset evidence references;
- retrieval miss or partial retrieval when exact gold evidence exists;
- answer failure despite complete retrieved evidence;
- answer failure with V2 gold evidence unavailable.

This separation prevents provider outages from being reported as retrieval
failures and prevents session-level or parent-level metadata from being promoted
to child-chunk recall evidence.
