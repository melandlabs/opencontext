# ai (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.


Core AI building blocks used by the OpenContext runtime. Provides the agent
loop, memory interface, sandbox execution surface, audio helpers, and shared
types.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Subpath Exports

- `ai` — Main entrypoint (commonly re-exports agent runtime)
- `ai/types` — Shared types (chat messages, providers, etc.)
- `ai/memory` — Memory layer abstractions and SQLite-backed impl
- `ai/store` — Cross-session persistent store helpers
- `ai/audio` — Audio input/output helpers (transcription, TTS glue)
- `ai/agent` — Agent runtime, native runner, supplemental input
- `ai/agent/native-cli` — Native CLI agent driver
- `ai/agent/native-runner` — Native agent runner
- `ai/agent/runtime` — Agent runtime core
- `ai/agent/supplemental-input` — Supplemental input channels
- `ai/agent/runtime-instructions` — Runtime instructions builder
- `ai/agent/image-gen` — Image generation wrapper
- `ai/agent/sandbox` — Sandboxed tool execution surface
- `ai/agent/sandbox/types` — Sandbox types
- `ai/agent/sandbox/plugin` — Sandbox plugin contract
- `ai/agent/sandbox/registry` — Sandbox registry
- `ai/agent/sandbox/providers/native` — Native sandbox provider
- `ai/agent/sandbox/providers/claude` — Claude sandbox provider
- `ai/agent/sandbox/providers/vercel` — Vercel sandbox provider

## Peer Dependencies

None (uses the AI SDK providers as regular dependencies).
