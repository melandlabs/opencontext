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
# Offline sample conversion: no Hugging Face dependency or network access
python dataset/convert.py --scale sample

# Non-sample conversion: install dependencies once
pip install pyarrow datasets

# Convert a published scale
python dataset/convert.py --scale 128k   # writes dataset/beam_128k.json
python dataset/convert.py --scale 500k   # writes dataset/beam_500k.json
python dataset/convert.py --scale 1m     # writes dataset/beam_1m.json
python dataset/convert.py --scale 10m    # writes dataset/beam_10m.json

# Run the local TypeScript evaluation (requires daemon and model credentials)
pnpm --filter @melandlabs/benchmark-beam benchmark -- \
  --dataset dataset/sample_conversation.json
```

## Published source mapping

`convert.py` uses an explicit mapping rather than deriving Hugging Face names:

| Local scale | Repository | Config | Split | Pinned revision |
| ----------- | ---------- | ------ | ----- | --------------- |
| `128k` | `Mohammadta/BEAM` | `default` | `100K` | `3205395e897e7318c7b094ef4e6047b9b82dbb03` |
| `500k` | `Mohammadta/BEAM` | `default` | `500K` | `3205395e897e7318c7b094ef4e6047b9b82dbb03` |
| `1m` | `Mohammadta/BEAM` | `default` | `1M` | `3205395e897e7318c7b094ef4e6047b9b82dbb03` |
| `10m` | `Mohammadta/BEAM-10M` | `default` | `10M` | `9b2096193fe74e2837e4713e483351e19817773c` |

The converter writes this source identity and its converter schema version into
the generated JSON. This gives large datasets a stable upstream identity even
when the run manifest intentionally skips a full-file SHA256.

Non-sample conversion checks `datasets`, `pyarrow`, arguments, and the output
path before calling Hugging Face. `sample` never imports those dependencies.

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
