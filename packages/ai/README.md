# @opencontext/ai

Core AI building blocks used by the OpenLoomi runtime. Provides the agent
loop, memory interface, sandbox execution surface, audio helpers, and shared
types.

## Installation

```sh
pnpm add @opencontext/ai
```

## Subpath Exports

- `@opencontext/ai` — Main entrypoint (commonly re-exports agent runtime)
- `@opencontext/ai/types` — Shared types (chat messages, providers, etc.)
- `@opencontext/ai/memory` — Memory layer abstractions and SQLite-backed impl
- `@opencontext/ai/store` — Cross-session persistent store helpers
- `@opencontext/ai/audio` — Audio input/output helpers (transcription, TTS glue)
- `@opencontext/ai/agent` — Agent runtime, native runner, supplemental input
- `@opencontext/ai/agent/native-cli` — Native CLI agent driver
- `@opencontext/ai/agent/native-runner` — Native agent runner
- `@opencontext/ai/agent/runtime` — Agent runtime core
- `@opencontext/ai/agent/supplemental-input` — Supplemental input channels
- `@opencontext/ai/agent/runtime-instructions` — Runtime instructions builder
- `@opencontext/ai/agent/image-gen` — Image generation wrapper
- `@opencontext/ai/agent/sandbox` — Sandboxed tool execution surface
- `@opencontext/ai/agent/sandbox/types` — Sandbox types
- `@opencontext/ai/agent/sandbox/plugin` — Sandbox plugin contract
- `@opencontext/ai/agent/sandbox/registry` — Sandbox registry
- `@opencontext/ai/agent/sandbox/providers/native` — Native sandbox provider
- `@opencontext/ai/agent/sandbox/providers/claude` — Claude sandbox provider
- `@opencontext/ai/agent/sandbox/providers/vercel` — Vercel sandbox provider

## Peer Dependencies

None (uses the AI SDK providers as regular dependencies).
