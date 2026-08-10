# voice-kokoro (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.

[Kokoro](https://github.com/hexgrad/kokoro) text-to-speech provider for
OpenContext. Streams synthesized speech from a local Kokoro model and exposes a
common `VoiceProvider` interface.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Exports

- `kokoroProvider` — Kokoro TTS provider implementation
- `KokoroVoice`, `KokoroOptions` — Provider configuration types

## Assets

The Kokoro model weights and voice samples are downloaded on first use; no
manual asset setup is required.
