# voice-whisper (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.


[Whisper](https://openai.com/research/whisper) speech-to-text provider for
OpenContext. Streams transcribed text from a local Whisper model and exposes a
common `VoiceProvider` interface.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Exports

- `whisperProvider` — Whisper STT provider implementation
- `WhisperModel`, `WhisperOptions` — Provider configuration types

## Assets

Whisper model weights are downloaded on first use; no manual asset setup is
required.
