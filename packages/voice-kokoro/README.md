# @opencontext/voice-kokoro

[Kokoro](https://github.com/hexgrad/kokoro) text-to-speech provider for
OpenContext. Streams synthesized speech from a local Kokoro model and exposes a
common `VoiceProvider` interface.

## Installation

```sh
pnpm add @opencontext/voice-kokoro
```

## Exports

- `kokoroProvider` — Kokoro TTS provider implementation
- `KokoroVoice`, `KokoroOptions` — Provider configuration types

## Assets

The Kokoro model weights and voice samples are downloaded on first use; no
manual asset setup is required.
