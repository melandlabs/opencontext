---
"@melandlabs/memory-store": minor
"@melandlabs/sqlite": minor
"@melandlabs/indexeddb": minor
---

Retrieval quality for the Agent Memory Leaderboard track.

- **Evidence rendering**: a search hit's `content` is now rendered as
  `[YYYY-MM-DD HH:MM] speaker: text` instead of a repeated guidance block plus
  a raw metadata dump. The answer model reads `content` verbatim, so it needs
  the date and the speaker to answer a "when" or "who" question, and the judge
  compares time granularity strictly. The old rendering is still available via
  `OPENCONTEXT_MESSAGE_CONTEXT_MODE=legacy`.
- **Lexical channel**: `deriveLexicalKeywords` drops English function words,
  keeps names (and searches adjacent names as a phrase), keeps negations and
  temporal words, and caps the result at 16 terms — an OR query over "what did
  the user say about …" no longer dilutes its own BM25 half.
- **Embedding fingerprint**: the SQLite index reports the embedding models that
  wrote its vectors, and the daemon reports `semantic_model_mismatch` (instead
  of a healthy-looking `semanticReady`) when the running model cannot compare
  the vectors it finds. A *mixed* index — one that holds vectors from two
  models — counts as a mismatch too: the neighbours from the foreign rows are
  not comparable with the running query vector.
- **OpenAI-compatible embeddings**: `--embedding-provider openai-compatible`
  (`EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`,
  `EMBEDDING_DIMENSIONS`) embeds through any OpenAI-compatible endpoint, with
  L2-normalized vectors.
