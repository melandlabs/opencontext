# Plan: scaffold `opencontext` runtime monorepo with all 26 packages moved from `openloomi`

## Context

`/Users/timi/codes/opencontext` is currently an empty scaffold (LICENSE + stub `# opencontext` README + generic Node `.gitignore`). Git history of `openloomi` shows a previously-recorded decision (commit `04a2b4ed`, deleted doc `docs/split-runtime-ui.md`) to carve the runtime sub-project out into a standalone repo `melandlabs/opencontext`, re-namespacing `@openloomi/*` → `@opencontext/*`. Phases 0–8 of that split are already done inside `openloomi/packages` — every package has been leaf-extracted and trimmed of UI-only deps — but **no code has actually been moved out yet**. A prior attempt (Phase 9, commit `b32b3039`) to restructure into `runtime/` + `ui/` top-level subdirs inside openloomi was rolled back (`d7b68ade`) because it created inconsistent dual homes.

User wants a new technical sub-project, with all 26 packages moved, README/structure inspired by open-source memory & context projects (graphiti, mem0, letta, cognee), but **content written from scratch — no copy-paste**.

## Decisions baked into this plan

| Decision | Choice | Rationale |
|---|---|---|
| Repo name | `opencontext` (already on disk + in deleted doc) | matches deleted doc + already initialized |
| Package namespace | `@opencontext/*` | matches deleted doc + keeps imports short |
| Package manager | pnpm 10.14 (matches openloomi) | monorepo already optimized for pnpm workspaces |
| Versioning | changesets | matches what modern OSS memory projects (mem0, letta, cognee) use for multi-package releases |
| Linter/formatter | Biome | matches openloomi's stack |
| History preservation | `git subtree split` per package + re-import into opencontext | preserves blame/commits; alternative (plain copy) loses attribution |
| Scope of move | ALL 26 packages (per user) | includes the 2 UI-specific ones (`ui-runtime`, `hooks`) — flagged as `optional` in their new package.json `peerDependencies` so the new repo can still build/test without Tauri |
| First commit | `chore(opencontext): initial scaffold + 26 packages moved from openloomi` | single atomic landing |

## OSS references (inspiration only — content is ours)

| Project | Borrowed pattern (structure) | What we write fresh (content) |
|---|---|---|
| [getzep/graphiti](https://github.com/getzep/graphiti) | `graphiti_core/{driver,llm_client,embedder,search,prompts,models,schemas,utils}` + `server/` + `mcp_server/` | Our own "Why?" pitch, our 4-verb API surface, our provider matrix |
| [mem0ai/mem0](https://github.com/mem0ai/mem0) | layered `memory/{main,temporal,graph}` + `vector_stores/` + `llms/` + `embeddings/` + `configs/` | Our own narrative on memory lifecycle |
| [letta-ai/letta](https://github.com/letta-ai/letta) | repo split into `letta/`, `letta_server/`, `letta_agent/`, `letta_client/` + `examples/` | Our own architecture diagram |
| [topoteretes/cognee](https://github.com/topoteretes/cognee) | `cognee/{tasks,databases,infrastructure,modules}` + `cognee-frontend/` + examples | Our own getting-started flow |

We **do not** copy any README prose, tagline, badge, or docs section text from these repos. Inspiration is structural.

## Step-by-step plan

### Step 1 — Init opencontext as a pnpm monorepo

**Files to write (relative to `/Users/timi/codes/opencontext/`):**

- `pnpm-workspace.yaml` — globs: `apps/*`, `packages/*`, `packages/ai/*`, `packages/integrations/*`, `services/*`
- `package.json` — private, name `opencontext-monorepo`, `packageManager: pnpm@10.14.0`, scripts: `build`, `lint`, `typecheck`, `test`, `format`, `clean`, `changeset`
- `tsconfig.base.json` — composite project references, `moduleResolution: bundler`, `strict: true`, `target: ES2022`
- `biome.json` — extends openloomi's biome.json (same lint rules)
- `.editorconfig`, `.nvmrc` (`20`), `.gitignore` (extends existing one)
- `.github/workflows/ci.yml` — matrix over packages, runs `pnpm install` → `pnpm -r build` → `pnpm -r typecheck` → `pnpm -r test` → `pnpm -r lint`
- `.github/dependabot.yml`, `.github/ISSUE_TEMPLATE/bug.yml`, `.github/ISSUE_TEMPLATE/feature.yml`
- `vitest.workspace.ts` — picks up every package's `vitest.config.ts`
- `.changeset/config.json` — `fixed: []`, packages versioned together initially
- `.npmrc` — `node-linker=hoisted`, `auto-install-peers=true`, `strict-peer-dependencies=false`
- `LICENSE` — already exists; verify matches openloomi
- `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`

### Step 2 — Move all 26 packages with history preservation

For each package in `/Users/timi/codes/openloomi/packages/` (plus `packages/ai/*`, `packages/integrations/*`):

1. `git -C /Users/timi/codes/openloomi subtree split --prefix=packages/<name> -b split-<name>`
2. `git -C /Users/timi/codes/opencontext fetch /Users/timi/codes/openloomi split-<name>`
3. `git -C /Users/timi/codes/opencontext merge --allow-unrelated-histories -m "chore(opencontext): move @openloomi/<name> from openloomi/packages/<name>"`

This preserves commit history (e.g. the Phase 0–8 split commits move with the package).

**Packages to move (26):**

Top-level (`/Users/timi/codes/openloomi/packages/`):
- `memory-store`, `rag`, `search`, `db`, `sqlite`, `indexeddb`, `storage`, `insights`, `audit`, `security`, `loop`, `cron`, `contracts`, `integrations-runtime`, `integrations`, `ai`, `env-config`, `shared`, `api`, `voice-kokoro`, `voice-whisper`, `config`, `i18n`, `ui-runtime`, `hooks`

Nested (`/Users/timi/codes/openloomi/packages/ai/`):
- `ai/memory-consolidation`, `ai/mcp`, `ai/rag`

### Step 3 — Re-namespace everything: `@openloomi/*` → `@opencontext/*`

For every moved package:
- `package.json`: `name: "@openloomi/<x>"` → `name: "@opencontext/<x>"`, bump version to `0.10.0`
- All `.ts`, `.tsx`, `.md` files: replace `from "@openloomi/<x>"` → `from "@opencontext/<x>"` (use `sed -i '' "s|@openloomi/|@opencontext/|g"` + manual fix for any non-import string occurrences)
- All `tsconfig.json` `paths` blocks updated
- All vitest config alias maps updated
- Workspace protocol in deps: `"@opencontext/<x>": "workspace:*"` (was `"@openloomi/<x>": "workspace:*"`)

**Special-case renames:**
- `@openloomi/ai/memory-consolidation` → `@opencontext/memory-consolidation` (flatten from nested to top-level)
- `@openloomi/ai/mcp` → `@opencontext/agent-mcp` (flatten + rename for clarity)
- `@openloomi/ai/rag` → merge into existing `@opencontext/rag` (delete the nested legacy package; the standalone one is canonical)

### Step 4 — Wire the two UI-specific packages as optional

`@opencontext/ui-runtime` and `@opencontext/hooks` depend on `@tauri-apps/*` and `react`. In their `package.json`:
- `peerDependenciesMeta: { "@tauri-apps/api": { "optional": true }, "react": { "optional": true } }`
- Add `// NOTE:` comment at top of each `index.ts` explaining why they're optional peers

This lets the opencontext CI build/test all packages without installing Tauri.

### Step 5 — Write monorepo-level docs (original content)

All content is **written from scratch**. Reference projects inform structure only.

**`README.md` (root)** — sections in this order:
1. Title block (name + 1-line tagline)
2. Tagline (one sentence, our framing — drafted in Phase 6 below)
3. Status badges (License, Version, Build, Discord if any)
4. **What is opencontext?** — 2–3 paragraph pitch. Differentiator: it's the runtime substrate that powers openloomi (and any compatible agent UI), with 4 verbs + 27 platform integrations + temporal context graph.
5. **Why opencontext?** — compare against plain RAG / static vector DB / no-memory LLM. 3 bullets.
6. **Core concepts** — 5 concepts: Memory Store, Context Graph, RAG, Loop Engine, Integration Mesh. Each with 1–2 sentence description + a tiny code snippet (our own API surface).
7. **The 4-verb API** — `remember`, `recall`, `forget`, `improve` (inspired by cognee's verbs but our own semantics; we describe `forget` differently since openloomi has `evidence-preserving-soft-forgetting` ADR already).
8. **Package catalog** — table of all 26 packages with one-liner + runtime/UI tag + required deps
9. **Architecture diagram** — ASCII diagram showing `apps → ui-runtime → contracts ← packages/* → ai → integrations`. Drawn from the actual dependency graph the previous Explore agent produced.
10. **Getting started** — `pnpm install`, `pnpm -r build`, link a package into your project
11. **Provider matrix** — table: SQLite-vec, pgvector, Chroma, OpenAI, Anthropic, Brave Search, 27 integration platforms
12. **Documentation links** — `docs/architecture.md`, `docs/philosophy.md`, per-package README
13. **Contributing** — link to CONTRIBUTING.md
14. **License** — MIT or Apache-2.0 (match openloomi)
15. **Acknowledgements** — one line each crediting graphiti/mem0/letta/cognee as structural inspiration, NO quotes from them

**`docs/architecture.md`** — original content, sections:
- Runtime substrate overview
- Memory lifecycle (write → consolidate → recall → correct → forget)
- Data flow diagrams (3 ASCII diagrams: ingest, recall, integrate)
- Storage backends (SQLite-vec, pgvector, Chroma, IndexedDB)
- Transport surfaces (HTTP daemon, MCP server, stdio, programmatic)
- Cross-process contracts

**`docs/philosophy.md`** — original content, sections:
- Why split from openloomi
- What stays runtime vs. UI (with the matrix)
- The 4 verbs in depth
- Why a temporal context graph beats static RAG (referencing graphiti's framing **concept** but writing our own prose)
- Why an integration mesh (27 platforms) is part of the substrate

**`docs/split-from-openloomi.md`** — original content, sections:
- History (Phase 0–9 commit timeline, the rollback, what we learned)
- What lives here now
- What stays in openloomi (just `apps/web`, `apps/marketing`, the bits of `apps/web/lib/loop|cron|db|integrations` that haven't been lifted yet)
- Migration guide for downstream consumers (`npm uninstall @openloomi/memory-store` → `npm install @opencontext/memory-store`)

**Per-package READMEs**: each moved package keeps its existing README (they already document the Phase X history), but with the namespace banner updated to `@opencontext/*`.

### Step 6 — Tagline + elevator pitch draft (to write in README, original)

> **opencontext** — open-source runtime substrate for agentic applications. A temporal context graph, 4-verb memory API, retrieval-augmented generation primitives, and a 27-platform integration mesh — designed to be embedded into any host application, but battle-tested inside the openloomi desktop companion.

> "opencontext is to agent runtimes what an ORM is to web apps: the layer that makes the hard parts (memory lifecycle, vector search, context correction, multi-platform connectivity) feel boring."

### Step 7 — Validate everything builds & tests pass

In `/Users/timi/codes/opencontext`:
- `pnpm install` succeeds
- `pnpm -r typecheck` passes (0 errors)
- `pnpm -r lint` passes (0 biome errors)
- `pnpm -r build` produces dist/ in every package
- `pnpm -r test` passes (vitest workspaces)
- `grep -r "@openloomi" packages apps` returns 0 matches outside of `CHANGELOG.md` historical notes
- `pnpm changeset status` shows all 26 packages versioned

### Step 8 — Wire consumers in `openloomi` (out of scope for this plan, but noted)

After opencontext is published, openloomi's `pnpm-workspace.yaml` switches from local workspace deps to published version deps (`"@opencontext/memory-store": "0.10.0"`). This is a **follow-up** PR in the openloomi repo, not part of this plan's deliverables. We will, however, commit a stub `apps/` and `services/` directory in opencontext so the workspace globs have something to anchor to.

## Critical files this plan creates

| Path | Purpose |
|---|---|
| `/Users/timi/codes/opencontext/pnpm-workspace.yaml` | Workspace definition |
| `/Users/timi/codes/opencontext/package.json` | Root monorepo manifest |
| `/Users/timi/codes/opencontext/tsconfig.base.json` | Shared TS config |
| `/Users/timi/codes/opencontext/biome.json` | Lint/format config |
| `/Users/timi/codes/opencontext/.github/workflows/ci.yml` | CI pipeline |
| `/Users/timi/codes/opencontext/.changeset/config.json` | Versioning config |
| `/Users/timi/codes/opencontext/README.md` | **Original** project README |
| `/Users/timi/codes/opencontext/docs/architecture.md` | Original architecture doc |
| `/Users/timi/codes/opencontext/docs/philosophy.md` | Original philosophy doc |
| `/Users/timi/codes/opencontext/docs/split-from-openloomi.md` | Original migration doc |
| `/Users/timi/codes/opencontext/packages/<26 moved packages>/` | Each package with re-namespaced code |
| `/Users/timi/codes/opencontext/apps/.gitkeep`, `services/.gitkeep` | Workspace anchors |

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| `git subtree split` may fail on deeply-nested sub-packages | Test on one package first (`memory-store`); if it fails, fall back to `git filter-repo --path packages/<name> --subdirectory-filter` |
| Cross-package imports break after rename | Run `pnpm -r typecheck` immediately after Step 3; iterate on `sed` patterns until 0 errors |
| Tauri/React peer-dep warnings during CI | Mark `@opencontext/ui-runtime` and `@opencontext/hooks` peers as `optional` (Step 4); add CI step that skips those two packages' build |
| README looks derivative of one of the references | Run a final `diff`-style review pass against graphiti/mem0/letta/cognee READMEs to confirm no sentence-level overlap |
| Some packages still pull in openloomi-specific assumptions (e.g. `~/.openloomi/loop/`) | Move those constants to a new `@opencontext/paths` package that we extract from `apps/web/lib/loop/paths.ts` during this work; namespace them under `~/.opencontext/` |
| Lost git author attribution | `git subtree split` preserves authors; verify with `git log --format="%an %ae" | sort -u` on one moved package |

## Acceptance criteria

- [ ] `/Users/timi/codes/opencontext` has a working pnpm monorepo
- [ ] All 26 packages moved and re-namespaced to `@opencontext/*`
- [ ] `pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm -r lint` all pass
- [ ] Zero remaining `@openloomi/*` import strings outside CHANGELOGs/historical notes
- [ ] Root README + `docs/{architecture,philosophy,split-from-openloomi}.md` written from scratch
- [ ] All docs reference open-source projects **only as inspirations**, not as quoted sources
- [ ] LICENSE matches openloomi's existing LICENSE
- [ ] CI workflow file present and runs in GitHub Actions
- [ ] Single squashed commit on `main`: `chore(opencontext): initial scaffold + 26 packages moved from openloomi/packages`

## Out of scope (follow-up PRs)

- Publishing packages to npm
- Updating openloomi repo to consume `@opencontext/*` instead of `@openloomi/*`
- Extracting the remaining `apps/web/lib/{loop,cron,db,integrations}/` heavy pieces into new `@opencontext/*` packages (these need their own design plan; some depend on DB schema + agent runtime)
- Building example apps in `opencontext/examples/` (deferred to a second PR)