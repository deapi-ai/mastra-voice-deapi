# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-18

First release.

### Added

- `DeapiVoice`, a Mastra voice provider (`MastraVoice`) for deAPI.
- `speak()`: text to speech with Kokoro (default), Chatterbox, Qwen3 TTS CustomVoice and Qwen3 TTS VoiceDesign, or any other text-to-speech model from the deAPI catalog. Returns an audio stream (MP3 by default).
- Model defaults: when `lang` or `speaker` is not given, the model's defaults (`info.defaults`) are read from `GET /models` and cached per instance for 10 minutes. Kokoro keeps built-in defaults (`af_alloy`, `en-us`) and needs no catalog lookup. Explicit options always win.
- Qwen3 VoiceDesign: `instructions` (constructor or per call, alias `instruct`) is sent as `instruct` with `mode: 'voice_design'`, detected from the model catalog.
- `listen()`: speech to text with Whisper Large V3 (`WhisperLargeV3Ct2`), JSON or plain-text transcripts.
- `getSpeakers()`: voices and languages of the configured speech model, from the deAPI model catalog.
- Job polling with configurable interval and timeout, readable errors with the API message, error code and reason.
- Works as an agent `voice` and inside `CompositeVoice` (input, output or both).
- Requires Node.js 22.13 or newer and `@mastra/core` 1.1 or newer (1.x).

[0.1.0]: https://github.com/deapi-ai/mastra-voice-deapi/releases/tag/v0.1.0
