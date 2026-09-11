# workspace-wiki fixture

A 3-file OKF folder used by `examples/src/simple/22-workspace.ts` to demo
`@melandlabs/workspace` end-to-end. The demo copies these files into a tmp
directory before each run so every run starts from a clean slate.

| File | `resource_type` | Role |
| --- | --- | --- |
| `a.md` | `note` (front-matter `type: contract`) | Limitation of Liability — 12-month cap. Cites `[./b.md]`. |
| `b.md` | `note` (front-matter `type: contract`) | Indemnification carve-out. Cites `[./a.md]`. |
| `law-clause.md` | `note` (front-matter `type: statute`) | Public law clause — matches `a.md`'s 12-month cap. |

The cross-file cites graph `a → b` (and back) is what the cross-file search
strategy walks. The demo runs lexical, semantic, hybrid, and cross-file
queries against this folder and asserts:

- 3 resources appear in `listWorkspaceResources`
- lexical search for "limitation" returns ≥ 1 hit
- re-running `updateWorkspaceContext` reports every file as `unchanged` (sha256 dedup)

Used in: `examples/src/simple/22-workspace.ts` and the workspace tutorial
(`docs/tutorials/use-cases/09-workspace-folder-indexing.md`).
