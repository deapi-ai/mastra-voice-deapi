# @deapi/mastra-voice

[deAPI](https://deapi.ai) voice provider for [Mastra](https://mastra.ai). It adds text-to-speech and speech-to-text on open-source models:

- **Speak (TTS):** Kokoro (41 voices: US and UK English, Spanish, French, Italian, Brazilian Portuguese, Hindi), Chatterbox (23 languages), Qwen3 TTS (10 languages)
- **Listen (STT):** Whisper Large V3 (CTranslate2)

## Installation

```bash
npm install @deapi/mastra-voice @mastra/core
```

Requires Node.js 22.13 or newer and `@mastra/core` 1.1 or newer (1.x).

Create an API key at [app.deapi.ai/settings/api-keys](https://app.deapi.ai/settings/api-keys) and set it:

```bash
DEAPI_API_KEY=your_api_key
```

## Usage

```typescript
import { createWriteStream, createReadStream } from 'node:fs';
import { DeapiVoice } from '@deapi/mastra-voice';

const voice = new DeapiVoice({
  speechModel: { name: 'Kokoro' },            // optional, default 'Kokoro'
  listeningModel: { name: 'WhisperLargeV3Ct2' }, // optional, default 'WhisperLargeV3Ct2'
  speaker: 'af_nova',                         // optional, default 'af_alloy'
});

// Text to speech (returns an MP3 stream)
const audio = await voice.speak('Hello from Mastra and deAPI!', { speaker: 'bm_george', lang: 'en-gb' });
audio.pipe(createWriteStream('hello.mp3'));

// Speech to text
const transcript = await voice.listen(createReadStream('meeting.mp3'), { filetype: 'mp3' });

// Voices of the current speech model
const speakers = await voice.getSpeakers(); // [{ voiceId: 'af_alloy', name: 'Alloy', language: 'en-us', ... }]
```

### Other speech models

Each model has its own languages and voices, and the language codes differ between models (`en-us` in Kokoro, `en` in Chatterbox, `English` in Qwen3). When you leave out `lang` or `speaker`, the provider uses the model's defaults from the deAPI model catalog (`GET /models`, cached for 10 minutes). Values you pass always win. Use `getSpeakers()` to list the voices and languages of the configured model.

```typescript
// Chatterbox: defaults to lang 'en' and voice 'default'
const chatterbox = new DeapiVoice({ speechModel: { name: 'Chatterbox' } });
await chatterbox.speak('Bonjour tout le monde !', { lang: 'fr' });

// Qwen3 CustomVoice: defaults to lang 'English' and voice 'Vivian'.
// `instructions` is optional style control.
const qwen = new DeapiVoice({ speechModel: { name: 'Qwen3_TTS_12Hz_1_7B_CustomVoice' }, speaker: 'Dylan' });
await qwen.speak('Hello there!', { instructions: 'Speak with a cheerful, energetic tone' });
```

### Voice design (Qwen3 VoiceDesign)

`Qwen3_TTS_12Hz_1_7B_VoiceDesign` has no preset voices. It creates a voice from a text description, which you pass as `instructions` (sent to the API as `instruct` with `mode: 'voice_design'`). Set it once in the constructor or per call:

```typescript
const designer = new DeapiVoice({
  speechModel: { name: 'Qwen3_TTS_12Hz_1_7B_VoiceDesign' },
  instructions: 'A warm female voice with a British accent, calm and measured',
});
const audio = await designer.speak('Welcome to the evening news.', { lang: 'English' });

// or per call, with any voice instance
await voice.speak('Welcome back!', {
  model: 'Qwen3_TTS_12Hz_1_7B_VoiceDesign',
  instructions: 'An energetic young male voice',
});
```

Without a description the call fails before any job is submitted.

### With an agent

```typescript
import { createReadStream } from 'node:fs';
import { Agent } from '@mastra/core/agent';
import { DeapiVoice } from '@deapi/mastra-voice';

const agent = new Agent({
  id: 'narrator',
  name: 'Narrator',
  instructions: 'You narrate short stories.',
  model: 'openai/gpt-4o-mini',
  voice: new DeapiVoice({ speaker: 'bm_george' }),
});

const audio = await agent.voice.speak('Once upon a time...', { lang: 'en-gb' });
const text = await agent.voice.listen(createReadStream('question.mp3'));
```

### With CompositeVoice

Use `CompositeVoice` to combine deAPI with another provider, for example deAPI for transcription and a different provider for speech, or two deAPI models:

```typescript
import { Agent } from '@mastra/core/agent';
import { CompositeVoice } from '@mastra/core/voice';
import { DeapiVoice } from '@deapi/mastra-voice';

const voice = new CompositeVoice({
  input: new DeapiVoice(), // listen: Whisper Large V3
  output: new DeapiVoice({ speechModel: { name: 'Qwen3_TTS_12Hz_1_7B_CustomVoice' }, speaker: 'Serena' }), // speak
});

const agent = new Agent({ id: 'assistant', name: 'Assistant', instructions: 'You are helpful.', model: 'openai/gpt-4o-mini', voice });
```

## Options

### Constructor

| Option | Default | Description |
| --- | --- | --- |
| `speechModel.name` | `Kokoro` | `Kokoro`, `Chatterbox`, `Qwen3_TTS_12Hz_1_7B_CustomVoice`, `Qwen3_TTS_12Hz_1_7B_VoiceDesign` or any TTS model slug from `GET /models` |
| `speechModel.apiKey` | `DEAPI_API_KEY` | API key for speech |
| `listeningModel.name` | `WhisperLargeV3Ct2` | Transcription model |
| `listeningModel.apiKey` | `DEAPI_API_KEY` | API key for transcription |
| `speaker` | model default (`af_alloy` for Kokoro) | Default voice ID for the configured speech model |
| `instructions` | none | Voice description (Qwen3 VoiceDesign, required there) or style instruction (Qwen3 CustomVoice) |
| `pollIntervalMs` | `1000` | How often to check job status |
| `timeoutMs` | `300000` | Maximum time to wait for a job |
| `baseUrl` | `https://api.deapi.ai/api/v2` | API base URL |

### `speak(text, options)`

`speaker`, `model`, `lang` (codes depend on the model, for example `en-us`, `en-gb`, `es`, `fr-fr` in Kokoro), `instructions` (or `instruct`), `mode` (detected from the model catalog when omitted), `speed` (0.5–2 in Kokoro), `format` (default `mp3`), `sampleRate` (default `24000`). Missing values come from the model's defaults. Any other field is passed to [`POST /audio/speech`](https://docs.deapi.ai/api/v2/audio/speech).

### `listen(audio, options)`

`filetype` (default `mp3`), `includeTimestamps` (default `false`), `model`.

## How it works

deAPI runs jobs asynchronously. `speak` and `listen` submit a job, poll `GET /jobs/{id}` until it is done, then download the result. Pricing is per job, see [deapi.ai/pricing](https://deapi.ai/pricing).

## Development

```bash
npm install
npm test                          # unit tests (mocked)
npm run test:coverage             # unit tests with coverage
DEAPI_API_KEY=... npm test        # also runs the live round-trip test
npm run build
```

## License

MIT
