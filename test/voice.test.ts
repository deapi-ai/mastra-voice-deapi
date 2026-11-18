import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { DeapiVoice } from '../src/index.js';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function readAll(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

describe('DeapiVoice (mocked)', () => {
  it('throws without an API key', () => {
    const previous = process.env.DEAPI_API_KEY;
    delete process.env.DEAPI_API_KEY;
    expect(() => new DeapiVoice()).toThrow(/DEAPI_API_KEY/);
    if (previous) process.env.DEAPI_API_KEY = previous;
  });

  it('speak submits a job, polls it and streams the audio', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { request_id: 'req-1' } }))
      .mockResolvedValueOnce(jsonResponse({ data: { status: 'processing' } }))
      .mockResolvedValueOnce(jsonResponse({ data: { status: 'done', result_url: 'https://results.example/a.mp3' } }))
      .mockResolvedValueOnce(new Response(Buffer.from('MP3DATA')));

    const voice = new DeapiVoice({ speechModel: { apiKey: 'k' }, listeningModel: { apiKey: 'k' }, pollIntervalMs: 1, fetch: fetchMock });
    const audio = await readAll(await voice.speak('Hello there', { speaker: 'bm_george', lang: 'en-gb' }));

    expect(audio.toString()).toBe('MP3DATA');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.deapi.ai/api/v2/audio/speech');
    expect(init.headers.Authorization).toBe('Bearer k');
    expect(JSON.parse(init.body)).toMatchObject({ text: 'Hello there', model: 'Kokoro', voice: 'bm_george', lang: 'en-gb', format: 'mp3' });
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.deapi.ai/api/v2/jobs/req-1');
  });

  it('speak rejects empty text', async () => {
    const voice = new DeapiVoice({ speechModel: { apiKey: 'k' }, listeningModel: { apiKey: 'k' }, fetch: vi.fn() });
    await expect(voice.speak('   ')).rejects.toThrow('Input text is empty');
  });

  it('listen uploads the audio and returns the transcript from result_url', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { request_id: 'req-2' } }))
      .mockResolvedValueOnce(jsonResponse({ data: { status: 'done', result: null, result_url: 'https://results.example/t.txt' } }))
      .mockResolvedValueOnce(new Response('Hello world.\n'));

    const voice = new DeapiVoice({ speechModel: { apiKey: 'k' }, listeningModel: { apiKey: 'k' }, pollIntervalMs: 1, fetch: fetchMock });
    const text = await voice.listen(Readable.from([Buffer.from('fake-audio')]), { filetype: 'wav' });

    expect(text).toBe('Hello world.');
    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(form.get('model')).toBe('WhisperLargeV3Ct2');
    expect(form.get('include_ts')).toBe('false');
    expect((form.get('source_file') as File).name).toBe('audio.wav');
  });

  it('surfaces job failures and API errors', async () => {
    const failing = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { request_id: 'req-3' } }))
      .mockResolvedValueOnce(jsonResponse({ data: { status: 'error', error_code: 'E1', error_reason: 'bad input' } }));
    const voice = new DeapiVoice({ speechModel: { apiKey: 'k' }, listeningModel: { apiKey: 'k' }, pollIntervalMs: 1, fetch: failing });
    await expect(voice.speak('hi there')).rejects.toThrow('E1: bad input');

    const unauthorized = vi.fn().mockResolvedValueOnce(jsonResponse({ message: 'Unauthenticated.' }, 401));
    const voice2 = new DeapiVoice({ speechModel: { apiKey: 'k' }, listeningModel: { apiKey: 'k' }, fetch: unauthorized });
    await expect(voice2.speak('hi there')).rejects.toThrow('401: Unauthenticated.');
  });

  it('getSpeakers maps the model catalog voices', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        data: [
          { slug: 'Kokoro', languages: [{ name: 'English (GB)', slug: 'en-gb', voices: [{ name: 'George', slug: 'bm_george', gender: 'male' }] }] },
        ],
      }),
    );
    const voice = new DeapiVoice({ speechModel: { apiKey: 'k' }, listeningModel: { apiKey: 'k' }, fetch: fetchMock });
    expect(await voice.getSpeakers()).toEqual([
      { voiceId: 'bm_george', name: 'George', language: 'en-gb', languageName: 'English (GB)', gender: 'male' },
    ]);
  });
});

// Shapes taken from GET /models (info.defaults and info.features of the TTS models).
const CATALOG = [
  {
    slug: 'Kokoro',
    info: {
      defaults: { lang: 'en-us', speed: 1, voice: 'af_alloy', format: 'mp3', sample_rate: 24000 },
      features: { supports_voice_clone: false, supports_custom_voice: true, supports_voice_design: false },
    },
  },
  {
    slug: 'Chatterbox',
    info: {
      defaults: { lang: 'en', speed: 1, voice: 'default', format: 'mp3', sample_rate: 24000 },
      features: { supports_voice_clone: false, supports_custom_voice: true, supports_voice_design: false },
    },
  },
  {
    slug: 'Qwen3_TTS_12Hz_1_7B_CustomVoice',
    info: {
      defaults: { lang: 'English', speed: 1, voice: 'Vivian', format: 'mp3', sample_rate: 24000 },
      features: { supports_voice_clone: false, supports_custom_voice: true, supports_voice_design: false },
    },
  },
  {
    slug: 'Qwen3_TTS_12Hz_1_7B_VoiceDesign',
    info: {
      defaults: { lang: 'English', speed: 1, voice: 'default', format: 'mp3', sample_rate: 24000 },
      features: { supports_voice_clone: false, supports_custom_voice: false, supports_voice_design: true },
    },
  },
  { slug: 'NoDefaultsTTS', info: { defaults: null, features: null } },
  { slug: 'NoVoiceTTS', info: { defaults: { lang: 'en' } } },
];

/** Routes requests by URL: the model catalog (optionally split into pages), job submit, job status, download. */
function routedFetch(pages: unknown[][] = [CATALOG]) {
  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/models')) {
      const page = Number(parsed.searchParams.get('page') ?? '1');
      return jsonResponse({ data: pages[page - 1] ?? [], meta: { current_page: page, last_page: pages.length } });
    }
    if (parsed.pathname.endsWith('/audio/speech')) return jsonResponse({ data: { request_id: 'req-tts' } });
    if (parsed.pathname.includes('/jobs/')) {
      return jsonResponse({ data: { status: 'done', result_url: 'https://results.example/a.mp3' } });
    }
    return new Response(Buffer.from('MP3DATA'));
  });
}

function speechBody(fetchMock: ReturnType<typeof routedFetch>) {
  const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/audio/speech'));
  if (!call) throw new Error('no speech request');
  return JSON.parse(String(call[1]?.body));
}

function catalogCalls(fetchMock: ReturnType<typeof routedFetch>) {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes('/models')).map(([url]) => String(url));
}

function voiceWith(fetchMock: ReturnType<typeof routedFetch>, config: Record<string, unknown> = {}) {
  return new DeapiVoice({ speechModel: { apiKey: 'k' }, listeningModel: { apiKey: 'k' }, pollIntervalMs: 1, fetch: fetchMock, ...config });
}

describe('DeapiVoice speak defaults per model', () => {
  it('Kokoro keeps the built-in defaults and does not read the catalog', async () => {
    const fetchMock = routedFetch();
    const audio = await readAll(await voiceWith(fetchMock).speak('Hello there'));

    expect(audio.toString()).toBe('MP3DATA');
    expect(catalogCalls(fetchMock)).toEqual([]);
    expect(speechBody(fetchMock)).toEqual({
      text: 'Hello there',
      model: 'Kokoro',
      voice: 'af_alloy',
      lang: 'en-us',
      format: 'mp3',
      sample_rate: 24000,
      speed: 1,
    });
  });

  it('Kokoro uses the constructor speaker', async () => {
    const fetchMock = routedFetch();
    await voiceWith(fetchMock, { speaker: 'af_nova' }).speak('Hello there');
    expect(speechBody(fetchMock)).toMatchObject({ voice: 'af_nova', lang: 'en-us' });
  });

  it('Chatterbox takes lang and voice from the model defaults', async () => {
    const fetchMock = routedFetch();
    await voiceWith(fetchMock, { speechModel: { name: 'Chatterbox', apiKey: 'k' } }).speak('Hello there');

    expect(catalogCalls(fetchMock)).toEqual(['https://api.deapi.ai/api/v2/models?per_page=100&page=1']);
    const body = speechBody(fetchMock);
    expect(body).toEqual({ text: 'Hello there', model: 'Chatterbox', lang: 'en', voice: 'default', format: 'mp3', sample_rate: 24000, speed: 1 });
    expect(body).not.toHaveProperty('mode');
  });

  it('Qwen3 CustomVoice takes lang and voice from the defaults and passes a style instruction', async () => {
    const fetchMock = routedFetch();
    const voice = voiceWith(fetchMock, { speechModel: { name: 'Qwen3_TTS_12Hz_1_7B_CustomVoice', apiKey: 'k' } });
    await voice.speak('Hello there', { instructions: 'Speak with a happy tone' });

    expect(speechBody(fetchMock)).toMatchObject({
      model: 'Qwen3_TTS_12Hz_1_7B_CustomVoice',
      lang: 'English',
      voice: 'Vivian',
      instruct: 'Speak with a happy tone',
    });
    expect(speechBody(fetchMock)).not.toHaveProperty('mode');
  });

  it('Qwen3 VoiceDesign sends mode voice_design and the constructor instructions', async () => {
    const fetchMock = routedFetch();
    const voice = voiceWith(fetchMock, {
      speechModel: { name: 'Qwen3_TTS_12Hz_1_7B_VoiceDesign', apiKey: 'k' },
      instructions: 'A warm female voice with a British accent',
    });
    await voice.speak('Hello there');

    const body = speechBody(fetchMock);
    expect(body).toEqual({
      text: 'Hello there',
      model: 'Qwen3_TTS_12Hz_1_7B_VoiceDesign',
      mode: 'voice_design',
      instruct: 'A warm female voice with a British accent',
      lang: 'English',
      format: 'mp3',
      sample_rate: 24000,
      speed: 1,
    });
  });

  it('Qwen3 VoiceDesign takes the description from speak options (instruct alias too)', async () => {
    const fetchMock = routedFetch();
    const voice = voiceWith(fetchMock, { instructions: 'ignored' });
    await voice.speak('Hello there', { model: 'Qwen3_TTS_12Hz_1_7B_VoiceDesign', instruct: 'A deep calm male voice', lang: 'French' });
    expect(speechBody(fetchMock)).toMatchObject({ mode: 'voice_design', instruct: 'A deep calm male voice', lang: 'French' });
  });

  it('Qwen3 VoiceDesign without a description fails before submitting a job', async () => {
    const fetchMock = routedFetch();
    const voice = voiceWith(fetchMock, { speechModel: { name: 'Qwen3_TTS_12Hz_1_7B_VoiceDesign', apiKey: 'k' } });
    await expect(voice.speak('Hello there')).rejects.toThrow(/Pass instructions/);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/audio/speech'))).toBe(false);
  });

  it('explicit options override the catalog defaults', async () => {
    const fetchMock = routedFetch();
    const voice = voiceWith(fetchMock, { speechModel: { name: 'Chatterbox', apiKey: 'k' } });
    await voice.speak('Hallo zusammen', { lang: 'de', speaker: 'default', speed: 1, format: 'mp3', sampleRate: 24000, mode: 'custom_voice' });

    expect(catalogCalls(fetchMock)).toEqual([]);
    expect(speechBody(fetchMock)).toMatchObject({ model: 'Chatterbox', lang: 'de', voice: 'default', mode: 'custom_voice' });
  });

  it('a partial override keeps the explicit value and fills the rest from the catalog', async () => {
    const fetchMock = routedFetch();
    const voice = voiceWith(fetchMock, { speechModel: { name: 'Qwen3_TTS_12Hz_1_7B_CustomVoice', apiKey: 'k' }, speaker: 'Dylan' });
    await voice.speak('Hello there', { lang: 'Chinese' });
    expect(speechBody(fetchMock)).toMatchObject({ lang: 'Chinese', voice: 'Dylan' });
  });

  it('the constructor speaker of one model is not sent to another model', async () => {
    const fetchMock = routedFetch();
    const voice = voiceWith(fetchMock, { speaker: 'bm_george' });
    await voice.speak('Hello there', { model: 'Chatterbox' });
    expect(speechBody(fetchMock)).toMatchObject({ model: 'Chatterbox', voice: 'default', lang: 'en' });
  });

  it('caches the catalog and follows its pages', async () => {
    const fetchMock = routedFetch([CATALOG.slice(0, 2), CATALOG.slice(2)]);
    const voice = voiceWith(fetchMock, { speechModel: { name: 'Qwen3_TTS_12Hz_1_7B_CustomVoice', apiKey: 'k' } });
    await voice.speak('Hello there');
    await voice.speak('Hello again');

    expect(catalogCalls(fetchMock)).toEqual([
      'https://api.deapi.ai/api/v2/models?per_page=100&page=1',
      'https://api.deapi.ai/api/v2/models?per_page=100&page=2',
    ]);
    expect(speechBody(fetchMock)).toMatchObject({ voice: 'Vivian' });
  });

  it('fails clearly when the model is unknown or has no defaults', async () => {
    const fetchMock = routedFetch();
    await expect(voiceWith(fetchMock).speak('Hello there', { model: 'MissingModel' })).rejects.toThrow(/not found in the model catalog/);
    await expect(voiceWith(fetchMock).speak('Hello there', { model: 'NoDefaultsTTS' })).rejects.toThrow(/no default language/);
    await expect(voiceWith(fetchMock).speak('Hello there', { model: 'NoVoiceTTS' })).rejects.toThrow(/no default voice/);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/audio/speech'))).toBe(false);
  });

  it('does not cache a failed catalog request', async () => {
    const fetchMock = routedFetch();
    fetchMock.mockImplementationOnce(async () => jsonResponse({ message: 'Server Error' }, 500));
    const voice = voiceWith(fetchMock, { speechModel: { name: 'Chatterbox', apiKey: 'k' } });

    await expect(voice.speak('Hello there')).rejects.toThrow('500: Server Error');
    await voice.speak('Hello there');
    expect(speechBody(fetchMock)).toMatchObject({ voice: 'default', lang: 'en' });
  });
});

describe('DeapiVoice other paths', () => {
  it('getSpeakers fails for a model missing from the catalog', async () => {
    const fetchMock = routedFetch();
    const voice = voiceWith(fetchMock, { speechModel: { name: 'MissingModel', apiKey: 'k' } });
    await expect(voice.getSpeakers()).rejects.toThrow(/not found/);
  });

  it('listen returns the inline JSON transcript and forwards extra fields', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { request_id: 'req-4' } }))
      .mockResolvedValueOnce(jsonResponse({ data: { status: 'done', result: '{"text":" Hi there. ","language":"en"}' } }));
    const voice = voiceWith(fetchMock as never);
    const text = await voice.listen(Readable.from(['fake-audio']), { includeTimestamps: true, language: 'en', skipped: undefined });

    expect(text).toBe('Hi there.');
    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(form.get('include_ts')).toBe('true');
    expect(form.get('language')).toBe('en');
    expect(form.has('skipped')).toBe(false);
  });

  it('reports a missing request id, a missing result and a failed download', async () => {
    const noId = vi.fn().mockResolvedValueOnce(jsonResponse({ data: {} }));
    await expect(voiceWith(noId as never).speak('Hello there')).rejects.toThrow(/request_id/);

    const noUrl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { request_id: 'r' } }))
      .mockResolvedValueOnce(jsonResponse({ data: { status: 'done' } }));
    await expect(voiceWith(noUrl as never).speak('Hello there')).rejects.toThrow(/without an audio URL/);

    const noTranscript = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { request_id: 'r' } }))
      .mockResolvedValueOnce(jsonResponse({ data: { status: 'done', result: '' } }));
    await expect(voiceWith(noTranscript as never).listen(Readable.from(['a']))).rejects.toThrow(/without a transcript/);

    const badDownload = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { request_id: 'r' } }))
      .mockResolvedValueOnce(jsonResponse({ data: { status: 'done', result_url: 'https://results.example/a.mp3' } }))
      .mockResolvedValueOnce(new Response('gone', { status: 404 }));
    await expect(voiceWith(badDownload as never).speak('Hello there')).rejects.toThrow('(404)');
  });

  it('times out a job that never finishes and keeps a non-JSON error body', async () => {
    const pending = vi.fn(async (url: string) =>
      String(url).endsWith('/audio/speech') ? jsonResponse({ data: { request_id: 'r' } }) : jsonResponse({ data: { status: 'processing' } }),
    );
    await expect(voiceWith(pending as never, { timeoutMs: 5 }).speak('Hello there')).rejects.toThrow(/did not finish within 5 ms/);

    const htmlError = vi.fn().mockResolvedValueOnce(new Response('<html>Bad Gateway</html>', { status: 502 }));
    await expect(voiceWith(htmlError as never).speak('Hello there')).rejects.toThrow('502: <html>Bad Gateway</html>');
  });

  it('reads text from a stream and accepts per-model API keys', async () => {
    const previous = process.env.DEAPI_API_KEY;
    process.env.DEAPI_API_KEY = 'env-key';
    try {
      const fetchMock = routedFetch();
      const voice = new DeapiVoice({ pollIntervalMs: 1, fetch: fetchMock, baseUrl: 'https://proxy.example/api/v2/' });
      await voice.speak(Readable.from(['Hello ', 'stream']));
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://proxy.example/api/v2/audio/speech');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer env-key');
      expect(speechBody(fetchMock).text).toBe('Hello stream');
      expect(await voice.getListener()).toEqual({ enabled: true });
    } finally {
      if (previous === undefined) delete process.env.DEAPI_API_KEY;
      else process.env.DEAPI_API_KEY = previous;
    }
  });

  it('throws without a listening API key', () => {
    const previous = process.env.DEAPI_API_KEY;
    delete process.env.DEAPI_API_KEY;
    try {
      expect(() => new DeapiVoice({ speechModel: { apiKey: 'k' } })).toThrow(/listening model/);
    } finally {
      if (previous !== undefined) process.env.DEAPI_API_KEY = previous;
    }
  });
});

describe.skipIf(!process.env.DEAPI_API_KEY)('DeapiVoice (live API)', () => {
  it('round-trips speech to text', async () => {
    const voice = new DeapiVoice();
    const speakers = await voice.getSpeakers();
    expect(speakers.some(s => s.voiceId === 'af_alloy')).toBe(true);

    const audio = await readAll(await voice.speak('The quick brown fox jumps over the lazy dog.'));
    expect(audio.length).toBeGreaterThan(1000);

    const transcript = await voice.listen(Readable.from([audio]));
    expect(transcript.toLowerCase()).toContain('quick brown fox');
  }, 180_000);
});
