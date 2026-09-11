---
"@melandlabs/workspace": minor
"@melandlabs/opencontext": minor
---

Add Excel / Apple Numbers spreadsheet parsing to `@melandlabs/workspace`'s `parsers-adapter`. `.xlsx` and `.xls` are converted via SheetJS (`xlsx`) — one CSV block per sheet, prefixed with `# Sheet: <name>` so the chunker preserves sheet boundaries. `.numbers` files are first converted with macOS `textutil -convert xlsx`, then routed through the SheetJS path.

The OKF walker now picks up `.xlsx`, `.xls`, and `.numbers` (macOS) alongside the existing `.md`, `.markdown`, `.txt`, `.pdf`, `.docx`, and `.pages` formats, and tags them with `resource_type: "spreadsheet"`.

The 22-workspace demo now ships a 6-file fixture folder (`.md` × 3, `.pdf`, `.docx`, `.xlsx`) and asserts `filesScanned ≥ 6`, `filesAdded ≥ 6`, `listWorkspaceResources ≥ 6`, and that the re-run reports every file as `unchanged` under sha256 dedup.
