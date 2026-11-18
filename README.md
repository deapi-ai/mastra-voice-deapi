# @deapi/mastra-voice

[deAPI](https://deapi.ai) voice provider for [Mastra](https://mastra.ai). It adds text-to-speech and speech-to-text on open-source models:

- **Speak (TTS):** Kokoro (41 voices: US and UK English, Spanish, French, Italian, Brazilian Portuguese, Hindi), Chatterbox (23 languages), Qwen3 TTS (10 languages)
- **Listen (STT):** Whisper Large V3

## Installation

```bash
npm install @deapi/mastra-voice
```

Get an API key at [app.deapi.ai](https://app.deapi.ai/register) and set it:

```bash
DEAPI_API_KEY=your_api_key
```

## Usage

```typescript
import { createWriteStream, createReadStream } from 'node:fs';
import { DeapiVoice } from '@deapi/mastra-voice';

const voice = new DeapiVoice({
  speechModel: { name: 'Kokoro' },            // optional, default 'Kokoro'
  listeningModel: { name: 'WhisperLargeV3' }, // optional, default 'WhisperLargeV3'
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

### With an agent

```typescript
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
```

## Options

### Constructor

| Option | Default | Description |
| --- | --- | --- |
| `speechModel.name` | `Kokoro` | `Kokoro`, `Chatterbox`, `Qwen3_TTS_12Hz_1_7B_CustomVoice`, `Qwen3_TTS_12Hz_1_7B_VoiceDesign` or any TTS model slug from `GET /models` |
| `speechModel.apiKey` | `DEAPI_API_KEY` | API key for speech |
| `listeningModel.name` | `WhisperLargeV3` | Transcription model |
| `listeningModel.apiKey` | `DEAPI_API_KEY` | API key for transcription |
| `speaker` | `af_alloy` | Default voice ID |
| `pollIntervalMs` | `1000` | How often to check job status |
| `timeoutMs` | `300000` | Maximum time to wait for a job |
| `baseUrl` | `https://api.deapi.ai/api/v2` | API base URL |

### `speak(text, options)`

`speaker`, `model`, `lang` (for example `en-us`, `en-gb`, `es`, `fr-fr`), `speed` (0.5–2), `format` (default `mp3`), `sampleRate` (default `24000`). Any other field is passed to [`POST /audio/speech`](https://docs.deapi.ai/api/v2/audio/speech).

### `listen(audio, options)`

`filetype` (default `mp3`), `includeTimestamps` (default `false`), `model`.

## How it works

deAPI runs jobs asynchronously. `speak` and `listen` submit a job, poll `GET /jobs/{id}` until it is done, then download the result. Pricing is per job, see [deapi.ai/pricing](https://deapi.ai/pricing).

## Development

```bash
npm install
npm test                          # unit tests (mocked)
DEAPI_API_KEY=... npm test        # also runs the live round-trip test
npm run build
```

## License

MIT
