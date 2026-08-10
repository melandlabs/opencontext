# @openloomi/ai

Core AI building blocks used by the OpenLoomi runtime. Provides the agent
loop, memory interface, sandbox execution surface, audio helpers, and shared
types.

## Installation

```sh
pnpm add @openloomi/ai
```

## Subpath Exports

- `@openloomi/ai` — Main entrypoint (commonly re-exports agent runtime)
- `@openloomi/ai/types` — Shared types (chat messages, providers, etc.)
- `@openloomi/ai/memory` — Memory layer abstractions and SQLite-backed impl
- `@openloomi/ai/store` — Cross-session persistent store helpers
- `@openloomi/ai/audio` — Audio input/output helpers (transcription, TTS glue)
- `@openloomi/ai/agent` — Agent runtime, native runner, supplemental input
- `@openloomi/ai/agent/native-cli` — Native CLI agent driver
- `@openloomi/ai/agent/native-runner` — Native agent runner
- `@openloomi/ai/agent/runtime` — Agent runtime core
- `@openloomi/ai/agent/supplemental-input` — Supplemental input channels
- `@openloomi/ai/agent/runtime-instructions` — Runtime instructions builder
- `@openloomi/ai/agent/image-gen` — Image generation wrapper
- `@openloomi/ai/agent/sandbox` — Sandboxed tool execution surface
- `@openloomi/ai/agent/sandbox/types` — Sandbox types
- `@openloomi/ai/agent/sandbox/plugin` — Sandbox plugin contract
- `@openloomi/ai/agent/sandbox/registry` — Sandbox registry
- `@openloomi/ai/agent/sandbox/providers/native` — Native sandbox provider
- `@openloomi/ai/agent/sandbox/providers/claude` — Claude sandbox provider
- `@openloomi/ai/agent/sandbox/providers/vercel` — Vercel sandbox provider

## Peer Dependencies

None (uses the AI SDK providers as regular dependencies).
