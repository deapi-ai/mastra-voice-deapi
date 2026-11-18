import { Agent } from '@mastra/core/agent';
import { CompositeVoice } from '@mastra/core/voice';
import { describe, expect, it, vi } from 'vitest';

import { DeapiVoice } from '../src/index.js';

// The agent's `voice` option type, derived from the installed @mastra/core: `IMastraVoice` since 1.82,
// `MastraVoice` from 1.1 to 1.81. `npm run typecheck` checks that DeapiVoice is assignable to it.
// @mastra/core 1.0.x typed it as `CompositeVoice`, so there the voice has to be wrapped in a CompositeVoice
// (CI runs this file on 1.0.0 without the typecheck, see .github/workflows/ci.yml).
type AgentVoice = NonNullable<ConstructorParameters<typeof Agent>[0]['voice']>;

function mockedDeapi() {
  const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/audio/speech') || path.endsWith('/audio/transcriptions')) {
      return Response.json({ data: { request_id: 'r' } });
    }
    if (path.includes('/jobs/')) {
      return Response.json({ data: { status: 'done', result: '{"text":"hello"}', result_url: 'https://results.example/a.mp3' } });
    }
    return new Response('MP3');
  });
  const voice = new DeapiVoice({ speechModel: { apiKey: 'k' }, listeningModel: { apiKey: 'k' }, pollIntervalMs: 1, fetch: fetchMock });
  return { voice, fetchMock };
}

async function readAll(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString();
}

describe('Mastra integration', () => {
  it('is accepted as an agent voice', async () => {
    const { voice, fetchMock } = mockedDeapi();
    const agentVoice: AgentVoice = voice;
    const agent = new Agent({
      id: 'narrator',
      name: 'Narrator',
      instructions: 'You narrate short stories.',
      model: 'openai/gpt-4o-mini',
      voice: agentVoice,
    });

    const audio = await agent.voice.speak('Once upon a time');
    expect(await readAll(audio as NodeJS.ReadableStream)).toBe('MP3');
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.deapi.ai/api/v2/audio/speech');
  });

  it('works as input and output of a CompositeVoice', async () => {
    const { voice, fetchMock } = mockedDeapi();
    const composite = new CompositeVoice({ input: voice, output: voice });

    expect(await readAll((await composite.speak('Hello there')) as NodeJS.ReadableStream)).toBe('MP3');
    const { Readable } = await import('node:stream');
    expect(await composite.listen(Readable.from([Buffer.from('audio')]))).toBe('hello');
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toContain('/api/v2/audio/transcriptions');
  });
});
