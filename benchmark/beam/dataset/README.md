# BEAM Dataset

This directory holds the BEAM benchmark data in the format the
TypeScript runner expects (one JSON file per scale).

## Files

| File                       | Purpose                                                           |
| -------------------------- | ----------------------------------------------------------------- |
| `convert.py`               | Downloads BEAM parquet from HuggingFace, normalizes, writes JSON. |
| `sample_conversation.json` | Bundled sample (1 conv × 1 question) for smoke tests.             |

## Quickstart

```bash
# 1. Install Python deps (one-time)
pip install pyarrow datasets

# 2. Convert a scale
python dataset/convert.py --scale 1m     # writes dataset/beam_1m.json
python dataset/convert.py --scale 10m    # writes dataset/beam_10m.json
python dataset/convert.py --scale sample # writes sample_conversation.json (no HF download)

# 3. Run the benchmark
pnpm --filter @openloomi/benchmark-beam benchmark -- \
  --dataset dataset/sample_conversation.json
```

## Why Python for the conversion?

The TS pipeline is intentionally Parquet-free:

- The TypeScript toolchain in this repo is bare-metal (no native
  modules). Adding a Parquet reader would force `snappy` /
  `apache-arrow` native deps and break the "pnpm install && go" setup.
- BEAM's reference implementations (Mem0, Mnemoverse, Hindsight) all
  assume a Python prep step.
- Conversion is a one-shot, $0 cost step. Caching the JSON locally
  means the benchmark itself stays fast.

## File format

The TS loader accepts either shape:

```jsonc
// Wrapped (preferred — includes scale tag)
{
  "scale": "1m",
  "conversations": [
    {
      "entry_id": "abc123",
      "scale": "1m",
      "chat": [{ "speaker": "user", "text": "...", "timestamp": "..." }, ...],
      "probing_questions": [
        {
          "question_id": "abc123_q1",
          "category": "information_extraction",  // see BEAM_QUESTION_CATEGORIES in src/types.ts
          "question": "What city did the user move to?",
          "atoms": ["Berlin"]                      // nugget atoms
        }
      ]
    }
  ]
}

// Bare array (also accepted)
[{ "entry_id": "...", "chat": [...], "probing_questions": [...] }, ...]
```

## Field-name tolerance

BEAM's HF parquet uses slightly different field names across the 4
buckets. `convert.py` and the TS loader both apply a defensive
normalization:

- `text` / `content` / `message` / `value` → `text`
- `speaker` / `role` / `from` / `name` → `speaker`
- `probing_questions` / `questions` / `evaluation_questions` → `probing_questions`
- `atoms` / `nuggets` → `atoms`

If you build your own dataset from a non-BEAM source, you can use
whichever field names you like — the loader will normalize.

## What is NOT included

We do NOT commit `beam_*.json` files to git (see `.gitignore`).
The full 10M bucket is ~10 GB and converts in 30–60 min. Generate
locally with `convert.py --scale 10m`.
