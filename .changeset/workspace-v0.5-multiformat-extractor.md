---
"@melandlabs/workspace": minor
"@melandlabs/opencontext": patch
---

Extend the multi-format text extractor in `@melandlabs/workspace` to cover `.html` / `.htm` / `.csv` / `.keynote` in addition to the existing `.md` / `.txt` / `.pdf` / `.docx` / `.xlsx` / `.xls` / `.pages` / `.numbers`. Barrel-export `extractText`, `extractTextRaw`, `detectMimeType`, `stripHtmlTags`, and the `ExtractedText` type so external callers (e.g. chokidar folder watchers) can route any of these through the same `extractText` pipeline the OKF bulk indexer already uses. `@melandlabs/okf`'s `indexOkfFolder` picks up the four new extensions automatically; no schema change.
