# LongMemEval Benchmark

> **Note:** this directory is opencontext's **own** scoring pipeline (custom
> BLEU/F1 + custom LLM-judge prompts). Its numbers are **not** comparable to
> the AML (Agent Memory Leaderboard) binary CORRECT/WRONG scoring. For the
> AML-comparable LongMemEval-S path, use [`../aml-local/`](../aml-local/),
> which drives the vendored official AML pipeline.

Benchmark suite for evaluating the OpenContext long-term memory retrieval system using the dataset.

## Overview

This benchmark evaluates how well the memory system answers questions from conversation history. It tests end-to-end query accuracy rather than retrieval recall - the system must not only retrieve the correct session but also correctly answer the question.

## Dataset

The LongMemEval dataset contains 500 question-answer pairs from conversation history. Each entry includes:

- **Conversation history** - Multi-session conversations between two people
- **Questions** - Queries about facts, preferences, temporal events, and multi-session information
- **Gold answers** - Ground truth answers for evaluation
- **Answer session IDs** - Which sessions contain the answer

### Question Types

| Type                        | Count | Description                                                  |
| --------------------------- | ----- | ------------------------------------------------------------ |
| `single-session-user`       | 70    | Questions about user preferences/facts from a single session |
| `single-session-preference` | 30    | Preference-related questions from one session                |
| `single-session-assistant`  | 56    | Questions about assistant behavior from one session          |
| `multi-session`             | 133   | Questions requiring information from multiple sessions       |
| `temporal-reasoning`        | 133   | Questions requiring date/time reasoning                      |
| `knowledge-update`          | 78    | Questions about evolving knowledge over time                 |

## Setup

```bash
# Install dependencies
pnpm install

# Copy environment file
cp .env.example .env

# Start the OpenContext memory daemon (from repo root, after build)
node packages/opencontext/dist/cli/opencontext.js http --embedding-provider local --memory-backend sqlite-vec
# or, if the global bin is installed:
opencontext http
# → serves http://127.0.0.1:7421, no auth
```

On Windows, after building the workspace dependencies, the bundled launcher
starts the same local SQLite + dense/FTS + local-reranker configuration in a
new timestamped database and writes its PID/database/log metadata under the
ignored `runtime/` directory:

```powershell
pnpm --filter @melandlabs/ai-rag build
pnpm --filter @melandlabs/memory-store build
pnpm --filter @melandlabs/opencontext build
./benchmark/longmemeval/start-daemon.ps1
```

Edit `.env` to add your API keys:

```env
# Answerer LLM (Anthropic-compatible endpoint, e.g. MiniMax)
ANTHROPIC_AUTH_TOKEN=your_anthropic_token_here
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic
ANSWER_MODEL=MiniMax-M3-highspeed

# Judge LLM (OpenRouter); also the answerer fallback if ANTHROPIC_AUTH_TOKEN is unset
OPENROUTER_API_KEY=your_openrouter_api_key_here
OPENROUTER_ANSWER_MODEL=deepseek/deepseek-v4-flash-0731
OPENROUTER_JUDGE_MODEL=qwen/qwen3.8-flash
LONGMEMEVAL_TOP_K=8
```

## Dataset Download

The dataset is downloaded automatically or can be placed manually:

```bash
# Download from HuggingFace
curl -sL "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json" \
  -o dataset/longmemeval_s_cleaned.json
```

## Usage

```bash
# Run full benchmark
pnpm benchmark -- --dataset dataset/longmemeval_s_cleaned.json

# Quick mode (first 5 entries)
pnpm benchmark -- --dataset dataset/longmemeval_s_cleaned.json --quick

# Run with specific question IDs
pnpm benchmark -- --dataset dataset/longmemeval_s_cleaned.json --samples qid1,qid2,qid3

# Save results to file
pnpm benchmark -- --dataset dataset/longmemeval_s_cleaned.json \
  --output results/longmemeval.json --no-resume
```

### CLI Options

| Flag          | Short | Description                         | Default            |
| ------------- | ----- | ----------------------------------- | ------------------ |
| `--dataset`   | `-d`  | Path to LongMemEval JSON dataset    | Required           |
| `--samples`   | `-s`  | Comma-separated question IDs to run | All                |
| `--quick`     | `-q`  | Limit to first 5 entries            | false              |
| `--output`    | `-o`  | Save results JSON to path           | None               |
| `--port`      | `-p`  | OpenContext daemon port (env: `OPENCONTEXT_PORT` / `OPENCONTEXT_URL`) | 7421 |
| `--resume`    |       | Reuse completed checkpoints for the same models | true    |
| `--no-resume` |       | Ignore checkpoints and run every selected entry | false   |
| `--preflight-only` |  | Validate readiness without ingest/model calls | false |

`LONGMEMEVAL_TOP_K` controls the final number of daemon-ranked hits passed to
the answerer (default 8, maximum 50). It does not configure chunking, candidate
generation, channel fusion, or reranking; those remain daemon-owned. Set
`LONGMEMEVAL_CHECKPOINT_DIR` to isolate checkpoints for a specific run.

Before ingest or model calls, the CLI checks the dataset and selected entries,
daemon, credentials, output/checkpoint paths, and arguments. It reports all
detected failures together and never prints credential values. `--help` does not
run these checks.

With `--resume`, both correct and incorrect completed judge results are reused;
only execution failures are retried. `--no-resume` always starts a fresh run.

## Output

The benchmark outputs:

- **Overall accuracy** - LLM judge accuracy across all question types
- **Per-type metrics** - F1, BLEU-1, BLEU-4 scores by question type
- **Per-question predictions** - Individual question results
- **Token usage** - Real provider usage when available; otherwise `null`
- **Run manifest** - Git commit and dirty/status evidence, full dataset identity
  (including SHA-256), models, retrieval top-k, selection parameters, resume
  mode, and wall-clock time
- **Question trace JSONL** - query, final ranked Top-K with full content,
  semantic/lexical/hybrid candidates, fused-before-rerank order, reranker
  identity/timing, answer and judge prompts/responses, token usage, and failure stage
- **Session ingest JSONL** - deterministic raw-message/session mapping, content
  hashes, batch status, latency, warnings, and errors
- **Retrieval diagnostics** - answer-session Recall@K, Hit@K, MRR,
  Precision@K, dataset-source coverage, and candidate-channel recall

With `--output results.json`, the manifest is written to
`results.json.manifest.json`, question traces to `results.trace.jsonl`, and
session ingestion evidence to `results.sessions.jsonl`. Without `--output`, the
run manifest is still written under `results/`, but the two diagnostic JSONL
artifacts are not emitted.

The benchmark maps each upstream LongMemEval session to exactly one
`RawMessage`. The daemon owns all child chunking, embedding, indexing,
retrieval, fusion, and reranking. The benchmark only preserves source session
IDs for provenance, calls `/v1/search`, passes the daemon's final Top-K results
to the existing answer prompt, and scores the answer.

For a formal run, start the daemon with a fresh database and use
`--no-resume`. A successful local smoke test or a resumed checkpoint set is not
a comparable full benchmark result.

Readiness check without paid model calls:

```bash
pnpm benchmark -- --dataset dataset/longmemeval_s_cleaned.json \
  --output results/longmemeval.json --no-resume --preflight-only
```

### Metrics

- **LLM Judge Accuracy** - Whether the LLM judge considers the answer correct
- **F1 Score** - Token-level precision/recall
- **BLEU-1/4** - N-gram overlap with brevity penalty

## Architecture

```
src/
├── index.ts           # CLI entry point
├── evaluator.ts       # LongMemEvalEvaluator - loads entries, runs QA evaluation
├── opencontext-client.ts  # OpenContext daemon client + answerer LLM calls
├── dataset.ts         # LongMemEval JSON parsing
├── metrics.ts         # BLEU, F1, LLM judge evaluation
├── scorer.ts          # Question type name mapping
├── prompts.ts         # LLM judge prompt template
├── contracts.ts       # MemoryStorageAdapter interface
└── types.ts           # TypeScript types
```

## Requirements

- Node.js 18+
- pnpm
- OpenContext memory daemon running on localhost (default http://127.0.0.1:7421, no auth; override with `--port` / `OPENCONTEXT_URL`)
- Anthropic-compatible API token for the answerer (or OpenRouter as fallback)
- OpenRouter API key (for LLM judge evaluation)
