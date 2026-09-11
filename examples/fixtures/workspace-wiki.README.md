# workspace-wiki fixture

A 5-file OKF folder used by `examples/src/simple/22-workspace.ts` to demo
`@melandlabs/workspace` end-to-end. The demo copies these files into a tmp
directory before each run so every run starts from a clean slate.

## Files

| File | Extension | `resource_type` | Role |
| --- | --- | --- | --- |
| `a.md` | `.md` | `note` (front-matter `type: contract`) | Limitation of Liability — 12-month cap. Cites `[./b.md]`. |
| `b.md` | `.md` | `note` (front-matter `type: contract`) | indemnification carve-out. Cites `[./a.md]`. |
| `law-clause.md` | `.md` | `note` (front-matter `type: statute`) | Public law clause — matches `a.md`'s 12-month cap. |
| `law-brief.pdf` | `.pdf` | `document` | Same public law clause, distributed as PDF (real binary). |
| `signed-addendum.docx` | `.docx` | `document` | Same clause as Word docx (real binary). |

The 3 markdown files form a cites graph (`a → b → a`) that the
cross-file search strategy walks. The PDF and DOCX are byte-identical
re-statements of the same law — they exercise the workspace parsers-adapter
multi-format path (`@melandlabs/rag`'s `parseFileToDocument` →
`PDFLoader` / `DocxLoader`).

## Format coverage

The fixture exists to demonstrate that `parsers-adapter.ts` actually works
across formats. Supported extensions (from
`packages/workspace/src/parsers-adapter.ts`):

- `.md` / `.markdown` — pass-through, front-matter parsed
- `.txt` — pass-through
- `.pdf` — `parseFileToDocument` (requires `pdf-parse`, declared in
  workspace deps)
- `.docx` — `parseFileToDocument` (requires `mammoth`, declared in
  workspace deps)
- `.pages` — `parseFileToDocument` (macOS only, via
  `AppleDocumentLoader`)

Not supported (not in fixture): `.xlsx`, `.numbers` (spreadsheets),
`.png`/`.jpg`/… (raster).

## Generating the binary files

```bash
# law-brief.pdf
pandoc law-clause.md -o law-brief.pdf

# signed-addendum.docx
echo "Public Law — Cap of Liability …" > /tmp/law-raw.txt
textutil -convert docx -output signed-addendum.docx /tmp/law-raw.txt
rm /tmp/law-raw.txt
```

This README is intentionally placed **outside** `workspace-wiki/` so the
walker's `SUPPORTED_EXTENSIONS` filter does not pick it up — only the 5
indexable files above are scanned.

## Demo assertions

The demo runs lexical, semantic, hybrid, and cross-file queries against
this folder and asserts:

- 5 resources appear in `listWorkspaceResources`
- lexical search for "limitation" returns ≥ 1 hit
- re-running `updateWorkspaceContext` reports every file as `unchanged`
  (sha256 dedup)

Used in: `examples/src/simple/22-workspace.ts` and the workspace tutorial
(`docs/tutorials/use-cases/09-workspace-folder-indexing.md`).
