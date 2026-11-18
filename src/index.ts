import { PassThrough } from 'node:stream';

import { MastraVoice } from '@mastra/core/voice';

const DEFAULT_BASE_URL = 'https://api.deapi.ai/api/v2';
const DEFAULT_SPEECH_MODEL = 'Kokoro';
const DEFAULT_LISTENING_MODEL = 'WhisperLargeV3';
const DEFAULT_SPEAKER = 'af_alloy';

/** Text-to-speech models available on deAPI. Any other model slug from `GET /models` also works. */
export type DeapiSpeechModel =
  | 'Kokoro'
  | 'Chatterbox'
  | 'Qwen3_TTS_12Hz_1_7B_CustomVoice'
  | 'Qwen3_TTS_12Hz_1_7B_VoiceDesign'
  | (string & {});

/** Speech-to-text models available on deAPI. */
export type DeapiListeningModel = 'WhisperLargeV3' | (string & {});

export interface DeapiModelConfig<TModel extends string = string> {
  name?: TModel;
  apiKey?: string;
}

export interface DeapiVoiceConfig {
  speechModel?: DeapiModelConfig<DeapiSpeechModel>;
  listeningModel?: DeapiModelConfig<DeapiListeningModel>;
  /** Default voice ID, for example `af_alloy` or `bm_george` (Kokoro). */
  speaker?: string;
  /** Override the API base URL. Defaults to `https://api.deapi.ai/api/v2`. */
  baseUrl?: string;
  /** How often to poll a job, in milliseconds. Defaults to 1000. */
  pollIntervalMs?: number;
  /** Give up waiting for a job after this many milliseconds. Defaults to 300000 (5 minutes). */
  timeoutMs?: number;
  /** Custom fetch implementation (useful for tests or proxies). */
  fetch?: typeof fetch;
}

export interface DeapiSpeakOptions {
  speaker?: string;
  /** Override the speech model for this call. */
  model?: DeapiSpeechModel;
  /** Language code, for example `en-us`, `en-gb`, `es`. Defaults to the model's default language. */
  lang?: string;
  /** Speaking speed, usually between 0.5 and 2. */
  speed?: number;
  /** Output format. Defaults to `mp3`. */
  format?: string;
  /** Output sample rate. Defaults to 24000. */
  sampleRate?: number;
  /** Extra request fields passed straight to `POST /audio/speech`. */
  [key: string]: unknown;
}

export interface DeapiListenOptions {
  /** File extension of the input audio, used for the upload file name. Defaults to `mp3`. */
  filetype?: string;
  /** Return segment timestamps in the transcript. Defaults to false. */
  includeTimestamps?: boolean;
  /** Override the listening model for this call. */
  model?: DeapiListeningModel;
  [key: string]: unknown;
}

export interface DeapiSpeaker {
  voiceId: string;
  name: string;
  language: string;
  languageName: string;
  gender?: string;
}

interface DeapiJob {
  status: string;
  result_url?: string | null;
  result?: unknown;
  error_code?: string | null;
  error_reason?: string | null;
}

interface DeapiModel {
  slug: string;
  languages?: Array<{ name: string; slug: string; voices?: Array<{ name: string; slug: string; gender?: string }> }>;
}

const FAILED_STATUSES = new Set(['error', 'failed', 'cancelled', 'canceled']);

/**
 * deAPI voice provider for Mastra: text-to-speech (Kokoro, Chatterbox, Qwen3 TTS)
 * and speech-to-text (Whisper Large V3) on open-source models.
 *
 * Get an API key at https://app.deapi.ai/register and set `DEAPI_API_KEY`.
 */
export class DeapiVoice extends MastraVoice {
  private readonly speechApiKey: string;
  private readonly listeningApiKey: string;
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor({
    speechModel,
    listeningModel,
    speaker,
    baseUrl,
    pollIntervalMs,
    timeoutMs,
    fetch: fetchImpl,
  }: DeapiVoiceConfig = {}) {
    const defaultApiKey = process.env.DEAPI_API_KEY;

    super({
      speechModel: {
        name: speechModel?.name ?? DEFAULT_SPEECH_MODEL,
        apiKey: speechModel?.apiKey ?? defaultApiKey,
      },
      listeningModel: {
        name: listeningModel?.name ?? DEFAULT_LISTENING_MODEL,
        apiKey: listeningModel?.apiKey ?? defaultApiKey,
      },
      speaker: speaker ?? DEFAULT_SPEAKER,
    });

    const speechApiKey = speechModel?.apiKey ?? defaultApiKey;
    if (!speechApiKey) {
      throw new Error('No API key provided for speech model. Set DEAPI_API_KEY or pass apiKey in speechModel.');
    }
    const listeningApiKey = listeningModel?.apiKey ?? defaultApiKey;
    if (!listeningApiKey) {
      throw new Error('No API key provided for listening model. Set DEAPI_API_KEY or pass apiKey in listeningModel.');
    }

    this.speechApiKey = speechApiKey;
    this.listeningApiKey = listeningApiKey;
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.pollIntervalMs = pollIntervalMs ?? 1000;
    this.timeoutMs = timeoutMs ?? 300_000;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
  }

  /** Lists the voices of the current speech model, read from deAPI's model catalog. */
  async getSpeakers(): Promise<DeapiSpeaker[]> {
    const modelSlug = this.speechModel?.name ?? DEFAULT_SPEECH_MODEL;
    const body = await this.request<{ data: DeapiModel[] }>(this.speechApiKey, '/models?per_page=100');
    const model = body.data.find(m => m.slug === modelSlug);
    if (!model) {
      throw new Error(`deAPI model "${modelSlug}" was not found in the model catalog.`);
    }
    return (model.languages ?? []).flatMap(language =>
      (language.voices ?? []).map(voice => ({
        voiceId: voice.slug,
        name: voice.name,
        language: language.slug,
        languageName: language.name,
        gender: voice.gender,
      })),
    );
  }

  async speak(input: string | NodeJS.ReadableStream, options?: DeapiSpeakOptions): Promise<NodeJS.ReadableStream> {
    const text = typeof input === 'string' ? input : (await this.streamToBuffer(input)).toString('utf-8');
    if (text.trim().length === 0) {
      throw new Error('Input text is empty');
    }

    const { speaker, model, lang, speed, format, sampleRate, ...rest } = options ?? {};
    const payload: Record<string, unknown> = {
      text,
      model: model ?? this.speechModel?.name ?? DEFAULT_SPEECH_MODEL,
      voice: speaker ?? this.speaker ?? DEFAULT_SPEAKER,
      format: format ?? 'mp3',
      sample_rate: sampleRate ?? 24000,
      speed: speed ?? 1,
      ...rest,
    };
    if (lang !== undefined) payload.lang = lang;
    else if (payload.model === DEFAULT_SPEECH_MODEL) payload.lang = 'en-us';

    const job = await this.runJob(this.speechApiKey, '/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!job.result_url) {
      throw new Error('deAPI speech job finished without an audio URL.');
    }

    const audio = await this.download(job.result_url);
    const stream = new PassThrough();
    stream.end(audio);
    return stream;
  }

  async getListener() {
    return { enabled: true };
  }

  async listen(audioStream: NodeJS.ReadableStream, options?: DeapiListenOptions): Promise<string> {
    const audio = await this.streamToBuffer(audioStream);
    const { filetype, includeTimestamps, model, ...rest } = options ?? {};

    const form = new FormData();
    form.append('source_file', new Blob([new Uint8Array(audio)]), `audio.${filetype ?? 'mp3'}`);
    form.append('model', String(model ?? this.listeningModel?.name ?? DEFAULT_LISTENING_MODEL));
    form.append('include_ts', includeTimestamps ? 'true' : 'false');
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined && value !== null) form.append(key, String(value));
    }

    const job = await this.runJob(this.listeningApiKey, '/audio/transcriptions', { method: 'POST', body: form });
    if (typeof job.result === 'string' && job.result.length > 0) {
      return job.result;
    }
    if (!job.result_url) {
      throw new Error('deAPI transcription job finished without a transcript.');
    }
    return (await this.download(job.result_url)).toString('utf-8').trim();
  }

  private async runJob(apiKey: string, path: string, init: RequestInit): Promise<DeapiJob> {
    const submitted = await this.request<{ data: { request_id: string } }>(apiKey, path, init);
    const requestId = submitted.data?.request_id;
    if (!requestId) {
      throw new Error(`deAPI did not return a request_id for ${path}.`);
    }

    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const { data: job } = await this.request<{ data: DeapiJob }>(apiKey, `/jobs/${encodeURIComponent(requestId)}`);
      if (job.status === 'done') {
        return job;
      }
      if (FAILED_STATUSES.has(job.status)) {
        const reason = [job.error_code, job.error_reason].filter(Boolean).join(': ') || 'unknown error';
        throw new Error(`deAPI job ${requestId} failed: ${reason}`);
      }
      await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
    }
    throw new Error(`deAPI job ${requestId} did not finish within ${this.timeoutMs} ms.`);
  }

  private async request<T>(apiKey: string, path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        // Keep the raw body.
      }
      throw new Error(`deAPI request ${path} failed with ${response.status}: ${message}`);
    }
    return JSON.parse(text) as T;
  }

  private async download(url: string): Promise<Buffer> {
    const response = await this.fetchImpl(url);
    if (!response.ok) {
      throw new Error(`Failed to download deAPI result (${response.status}).`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  private async streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
}
