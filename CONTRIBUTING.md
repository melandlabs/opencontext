# Contributing to OpenContext

Thanks for your interest in `OpenContext` — the runtime substrate for
agentic applications. This document is the canonical entry point for
contributors.

## Quick links

- **Code of Conduct**: [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)
- **Security policy**: [`SECURITY.md`](./SECURITY.md)
- **Architecture**: [`docs/architecture.md`](./docs/architecture.md)
- **Philosophy**: [`docs/philosophy.md`](./docs/philosophy.md)
- **Changesets (how we release)**: <https://github.com/changesets/changesets>

## Repository layout

```
opencontext/
├── apps/                       # Example host applications (web, cli, …)
├── packages/                   # Publishable libraries (@context/*)
│   ├── ai/                     # AI SDK wrappers, MCP server, memory consolidation
│   │   ├── memory-consolidation/
│   │   └── mcp/
│   └── integrations/           # Platform adapters (gmail, slack, …)
├── services/                   # Long-running daemons (memory HTTP, etc.)
├── docs/                       # Original architecture & philosophy docs
├── .changeset/                 # One Markdown file per change → released via CI
└── .github/                    # CI, issue templates, dependabot
```

## Local development

### Prerequisites

- **Node.js 22+** and **pnpm 10+**
- **Git**

### Platform-Specific Prerequisites

#### Windows

Developing on Windows requires additional C++ build tools for native modules like `better-sqlite3`.

**Required Visual Studio Build Tools components:**

- **Desktop development with C++**
- **ARM64/ARM64EC MSVC build tools** (matching your device architecture)
- **clang-related tooling** (LLVM)

**Node.js:** Node.js 22+ is recommended. Node 24 may have compatibility issues with some native modules on Windows devices.

**Installation steps:**

1. Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022)
2. During installation, select:
   - Workloads → "Desktop development with C++"
   - Individual components → "ARM64/ARM64EC MSVC build tools" (select the version matching your Windows ARM version)
   - Individual components → "clang-related tooling" (optional but recommended)

**Note:** Installing just the Visual Studio Build Tools alone is not sufficient. The specific ARM64 C++ components must be selected.

#### macOS

- Xcode Command Line Tools: `xcode-select --install`

#### Linux

- Build essentials: `sudo apt-get install build-essential` (Debian/Ubuntu)
- Required for `better-sqlite3` and other native modules

### Development Commands

```bash
nvm use  # or verify Node 22+ is active
pnpm install
pnpm -r build              # Build all packages
pnpm -r typecheck          # TypeScript validation
pnpm -r test               # Unit tests (vitest workspaces)
pnpm -r lint               # Biome lint
```

Optional filters: `pnpm --filter @context/memory-store test`.

## Adding a new package

1. Decide whether it is a **runtime** package (publishable) or **app/service**
   (private). Runtime packages belong under `packages/`, apps under `apps/`,
   daemons under `services/`.
2. Add an entry to `pnpm-workspace.yaml` if your package uses a new glob.
3. Create the directory with: `package.json`, `tsconfig.json`, `tsup.config.ts`,
   `src/index.ts`, `README.md`. Use `@context/<name>` as the package name.
4. Extend `packages/config/src/tsconfig.json` if you need a different compiler
   config — prefer extending it over inlining.
5. Add a changesets entry:
   ```bash
   pnpm changeset
   ```
   Select `@context/<name>`, choose `patch` / `minor` / `major`, write one
   sentence describing the change for the changelog.

## Coding style

- **Formatter**: Biome (config in `biome.json`). Run `pnpm -r lint:fix`.
- **TypeScript**: Strict mode is on. No `any` outside of typed adapters.
- **Imports**: Always use the workspace protocol for internal deps,
  e.g. `"@context/contracts": "workspace:*"`.
- **Tests**: Vitest. Co-locate `*.test.ts` next to the file under test.
- **Comments**: Explain _why_, not _what_. Public APIs get a JSDoc block.

## Commit messages

This repo follows [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(memory-store): add vector index hint to recall()
fix(storage): reject keys containing '..' segments
docs(architecture): clarify four-verb semantics
chore(deps): bump better-sqlite3 to 11.10.0
```

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`,
`build`, `ci`, `chore`, `revert`.

## Pull request checklist

- [ ] Tests added or updated for the change
- [ ] `pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm -r lint` all pass
- [ ] A changeset entry exists (if your change affects a publishable package)
- [ ] The PR description references an issue or explains the motivation
- [ ] No new dependencies introduced without justification in the PR body

## Releasing

We use changesets. The release flow is automated in `.github/workflows/ci.yml`:

1. Merge a PR with `.changeset/<name>.md` files
2. CI opens (or updates) a "Version Packages" PR
3. Merging that PR publishes to npm via `pnpm release`

## License

By contributing, you agree that your contributions will be licensed under the
project's [Apache-2.0 License](./LICENSE).
