---
"@melandlabs/ai-rag": patch
---

Republish with a complete `dist/`. 0.2.10 was published from a local
working tree whose `dist/` predated the `local-transformers-reranker`
entry, so the tarball declared `./local-transformers-reranker` in
`exports` without shipping `dist/local-transformers-reranker.js`.

`memory-store`'s `loadAiRag()` imports that subpath inside a
`Promise.all`, so the missing file took down the whole helper and
`opencontext mcp --embedding-provider local` crashed at startup with
`Cannot find module`.

No source change — `tsup.config.ts` already lists the entry, so a CI
build emits the file correctly.
