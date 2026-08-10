# Split from openloomi

This document records the history of carving the runtime sub-project
out of [openloomi](https://github.com/melandlabs/openloomi) into its
own monorepo at [melandlabs/opencontext](https://github.com/melandlabs/opencontext).
It is meant as context for maintainers and as a migration guide for
downstream consumers.

## Timeline

The split happened in phases, each corresponding to a series of commits
in the openloomi repo. The packages were extracted one leaf at a time,
with no behavioral change at each step, so that openloomi could keep
shipping while the carve-out was in progress.

### Phase 0 — Define the boundary types

Commit [`a25a5e21`](https://github.com/melandlabs/openloomi/commit/a25a5e21)
introduced `@openloomi/contracts` (now `@opencontext/contracts`). It
contained only types: `UserType`, `IntegrationId`, `AuthErrorCode`, and
zod schemas. The package was deliberately forbidden from importing
React, Next, Tauri, or bcrypt — anything that would tie it to a host
application.

The motivation was that openloomi's backend code could not import a
package that dragged in NextAuth as a transitive dependency. Pulling
the boundary types out into a leaf package made it possible for the
backend to consume them safely.

### Phase 1 — Break the IndexedDB coupling

Commit [`1d4d4ea4`](https://github.com/melandlabs/openloomi/commit/1d4d4ea4)
broke the static `@openloomi/indexeddb` coupling inside
`@openloomi/memory-store`. The store had previously imported types from
the IndexedDB package directly, which forced every consumer to drag in
browser globals. After this commit, `@openloomi/memory-store` declared
a structural `RawMessage` type and `@openloomi/indexeddb` became an
optional peer.

### Phase 2 — Migrate `UserType` consumers

Commit [`dc194290`](https://github.com/melandlabs/openloomi/commit/dc194290)
moved every consumer of the legacy `UserType` constant to import it
from `@openloomi/contracts` instead of from the app's auth module.

### Phase 3 — Migrate `IntegrationId` consumers

Each integration-specific module in the openloomi UI had been importing
`IntegrationId` from a local file. They were all updated to import
from `@openloomi/contracts/integration-id`.

### Phase 4 — Extract the database primitives

Commit [`044a3cc2`](https://github.com/melandlabs/openloomi/commit/044a3cc2)
introduced `@openloomi/db` with the dep-free leaf utilities
(`batchInsert`, password hashing) and the agent-goal runtime schema
types. Heavy DB code (schema definitions, queries, adapters) stayed
inside `apps/web/lib/db/` because it depended on the runtime database
connection.

### Phase 5 — Extract the Loop and Cron leaves

Commits
[`9408d1a6`](https://github.com/melandlabs/openloomi/commit/9408d1a6),
[`3da638e1`](https://github.com/melandlabs/openloomi/commit/3da638e1),
and [`90b2bc0e`](https://github.com/melandlabs/openloomi/commit/90b2bc0e)
extracted the dep-free leaves of the Loop engine (`paths`, `cli-path`,
`preferences`) and the Cron engine (`types`, `scheduler`,
`stream-response`) into `@openloomi/loop` and `@openloomi/cron`. The
heavy orchestration code (Loop `store.ts`, `runner.ts`, `tick.ts`,
`brief.ts`, `wrap.ts`, `connectors.ts`, `composio-bridge.ts`,
`handlers.ts`, `watcher.ts`, `server.ts`; Cron `executor.ts`,
`service.ts`, `local-scheduler.ts`, `insight-maintenance.ts`,
`notifications.ts`) stayed inside `apps/web/lib/loop/` and
`apps/web/lib/cron/` because they depend on the DB schema, agent
runtime, and integration adapters.

### Phase 6 — Extract insights

Commit [`d84ac5a8`](https://github.com/melandlabs/openloomi/commit/d84ac5a8)
moved the pure algorithm/filter logic for insight and event management
(`eventRank`, `focusClassifier`, filter schemas) into
`@openloomi/insights`.

### Phase 7 — Extract integrations glue

Commit [`1929e466`](https://github.com/melandlabs/openloomi/commit/1929e466)
extracted the integrations glue (authorization errors, platform
visuals, platform connectability, task-integration inference, OAuth
callback script) into `@openloomi/integrations-runtime`.

### Phase 8 — Split env/config + remove Tauri from shared

Commits [`9ee0b748`](https://github.com/melandlabs/openloomi/commit/9ee0b748)
and [`cecc7942`](https://github.com/melandlabs/openloomi/commit/cecc7942)
introduced `@openloomi/env-config` (env/deployment-mode/Tauri-path
constants) and `@openloomi/ui-runtime` (Tauri platform detection +
browser/Tauri filesystem adapters). `@openloomi/shared` stopped
statically importing `@tauri-apps/*`; instead it consumed the
`ui-runtime` adapter behind an interface.

### Phase 9 — Restructure into `runtime/` + `ui/` (rolled back)

Commit [`b32b3039`](https://github.com/melandlabs/openloomi/commit/b32b3039)
tried to restructure the new packages into `runtime/` and `ui/`
top-level directories inside openloomi. This was rolled back in
[`d7b68ade`](https://github.com/melandlabs/openloomi/commit/d7b68ade)
because only a handful of packages had moved, leaving inconsistent dual
homes. The decision was recorded: the right place for the split is a
separate repository, not a sub-directory.

### Phase 10 — Carve into opencontext

This is the phase this commit represents. All 49 leaf packages are
moved from `openloomi/packages/*` to `opencontext/packages/*`, renamed
from `@openloomi/*` to `@opencontext/*`, and re-published under the
opencontext monorepo. The split is now physical: two repositories, two
release pipelines, two sets of contributors.

## What lives in opencontext now

Everything that was extracted in Phases 0–8, plus:

- The `@opencontext/ai` umbrella and its three nested sub-packages
  (`memory-consolidation`, `mcp`, `rag`).
- The `@opencontext/integrations` umbrella and its 21 platform
  sub-packages (Gmail, Slack, Telegram, WhatsApp, LinkedIn, Instagram,
  X, Facebook Messenger, HubSpot, Notion, Asana, Jira, Linear,
  iMessage, Feishu, Dingtalk, QQbot, Weixin, RSS, Google Drive, Google
  Docs, Google Meet).
- The `@opencontext/integrations-runtime` glue package.
- The `@opencontext/voice-kokoro` and `@opencontext/voice-whisper`
  TTS/STT adapters.
- The shared utility packages: `shared`, `env-config`, `api`, `config`,
  `i18n`.
- The two UI-side packages that depend on Tauri or React
  (`@opencontext/ui-runtime`, `@opencontext/hooks`) — published with
  their host dependencies declared as optional peers.

## What stays in openloomi

- `apps/web` — the Next.js + Tauri desktop companion that consumes
  opencontext.
- `apps/marketing` — the public marketing/docs site.
- `benchmark/` — evaluation harnesses.
- `plugins/` — Tauri plugins.
- `skills/` — Claude Code skills for the openloomi companion.
- The pieces of `apps/web/lib/{loop,cron,db,integrations}/` that have
  not yet been extracted because they depend on the runtime database
  schema, the agent runtime, or the integration adapters.

These will move into opencontext in subsequent phases once the relevant
leaf interfaces stabilise.

## Migration guide for downstream consumers

If you depend on `@openloomi/memory-store` (or any other moved
package), the migration is a rename:

```bash
# Before
pnpm remove @openloomi/memory-store
pnpm add @opencontext/memory-store
```

```ts
// Before
import { createMemoryStore } from "@openloomi/memory-store";

// After
import { createMemoryStore } from "@opencontext/memory-store";
```

The API is identical for every moved package. The only behavioral
difference is that:

- `@opencontext/ui-runtime` and `@opencontext/hooks` now declare their
  host dependencies as optional peers. If you consume either of those,
  install `@tauri-apps/*` and `react>=18` at the application level.
- The path constants that used to live under `~/.openloomi/loop/` now
  live under `~/.opencontext/loop/`. See `@opencontext/loop/paths` for
  the migration shim.

## Outstanding work

- Carve the remaining `apps/web/lib/loop/{store,runner,tick,brief,wrap,connectors,composio-bridge,handlers,watcher,server}.ts`
  into `@opencontext/loop`.
- Carve the remaining `apps/web/lib/cron/{executor,service,local-scheduler,insight-maintenance,notifications}.ts`
  into `@opencontext/cron`.
- Carve the DB schema files from `apps/web/lib/db/` into
  `@opencontext/db`.
- Carve the integration adapters' heavy glue from
  `apps/web/lib/integrations/` into `@opencontext/integrations-runtime`.
- Publish each `@opencontext/*` package to npm and add a
  `release.yml` workflow that runs `pnpm changeset publish`.
- Add CI that validates `pnpm -r build && pnpm -r typecheck &&
  pnpm -r test && pnpm -r lint` against the openloomi monorepo's
  pinned versions.

## Credits

The shape of this split was discussed and re-shaped over several
months by the openloomi maintainers. The Phase 9 rollback was the
moment we realised that the right place for the runtime was its own
repository, not a sub-directory of openloomi.

The opencontext monorepo was scaffolded and populated in a single
session using Claude Opus 4.6 from Anthropic, with the planning,
extraction, and rename driven by a structured plan written by the
same session. The plan is preserved at
`.claude/plans/monorepo-scaffold.md` for reference.