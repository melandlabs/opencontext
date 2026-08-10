# @opencontext/voice-whisper

[Whisper](https://openai.com/research/whisper) speech-to-text provider for
OpenContext. Streams transcribed text from a local Whisper model and exposes a
common `VoiceProvider` interface.

## Installation

```sh
pnpm add @opencontext/voice-whisper
```

## Exports

- `whisperProvider` — Whisper STT provider implementation
- `WhisperModel`, `WhisperOptions` — Provider configuration types

## Assets

Whisper model weights are downloaded on first use; no manual asset setup is
required.
