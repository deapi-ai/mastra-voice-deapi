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
