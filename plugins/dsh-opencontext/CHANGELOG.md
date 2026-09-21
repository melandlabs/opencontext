# dsh-opencontext

## 0.4.0

### Minor Changes

- Bump peer / runtime dependencies to the current DSH and OpenContext lines, keeping the plugin on the actively-published train:
  - `@melandlabs/opencontext`: `^0.5.1` → **`^0.13.0`** — picks up the auto-compact, citation envelope, and wiki-distillation surfaces that `oc_search` / `oc_knowledge_search` now expose.
  - `@deepseek-ai/cordis`: `^4.0.1` → **`^4.0.2`**
  - `@deepseek-ai/schemastery`: `^3.18.1` → **`^3.18.2`**
  - `@deepseek-ai/dsh-agent`, `dsh-llm`, `dsh-tools`, `dsh-session`, `dsh-skill`, `dsh-system-prompt`: `^0.1.1-rc.2` → **`^0.1.5-rc.2`** (npm `next` dist-tag; the published `latest` tag has been reset to `0.1.0-rc.6` on the registry and is treated as stale here).
- Verified end-to-end: `pnpm typecheck` clean, `pnpm test` 16 files / 116 tests green, `pnpm build` emits `lib/` without errors.

## 0.3.2

### Patch Changes

- Ship `dsh-opencontext` 0.3.2: 16 tools (8 core + 3 summary + 2 insights + 3 knowledge/RAG), recall waterfall, auto-capture, turn-end summarization, tool-result capture, `opencontext` skill, and `/oc doctor` command.