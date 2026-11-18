import { PassThrough } from 'node:stream';

import { MastraVoice } from '@mastra/core/voice';

const DEFAULT_BASE_URL = 'https://api.deapi.ai/api/v2';
const DEFAULT_SPEECH_MODEL = 'Kokoro';
const DEFAULT_LISTENING_MODEL = 'WhisperLargeV3Ct2';
/** Built-in defaults for the default model, so Kokoro works without a catalog lookup. */
const KOKORO_DEFAULTS = { voice: 'af_alloy', lang: 'en-us' } as const;
const DEFAULT_FORMAT = 'mp3';
const DEFAULT_SAMPLE_RATE = 24000;
const DEFAULT_SPEED = 1;
/** The API returns at most 100 models per page. */
const MODELS_PER_PAGE = 100;
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;

/** Text-to-speech models available on deAPI. Any other model slug from `GET /models` also works. */
export type DeapiSpeechModel =
  | 'Kokoro'
  | 'Chatterbox'
  | 'Qwen3_TTS_12Hz_1_7B_CustomVoice'
  | 'Qwen3_TTS_12Hz_1_7B_VoiceDesign'
  | (string & {});

/** Speech-to-text models available on deAPI. */
export type DeapiListeningModel = 'WhisperLargeV3Ct2' | (string & {});

/** TTS mode. `custom_voice` uses a preset voice, `voice_design` creates a voice from a text description. */
export type DeapiSpeechMode = 'custom_voice' | 'voice_design' | (string & {});

export interface DeapiModelConfig<TModel extends string = string> {
  name?: TModel;
  apiKey?: string;
}

export interface DeapiVoiceConfig {
  speechModel?: DeapiModelConfig<DeapiSpeechModel>;
  listeningModel?: DeapiModelConfig<DeapiListeningModel>;
  /**
   * Default voice ID for the speech model, for example `af_alloy` or `bm_george` (Kokoro) or `Vivian` (Qwen3 CustomVoice).
   * Defaults to the model's default voice from the deAPI model catalog (`af_alloy` for Kokoro).
   */
  speaker?: string;
  /**
   * Voice description or style instruction, sent as `instruct`. Required by Qwen3 VoiceDesign
   * (for example "A warm female voice with a British accent"), optional style control for Qwen3 CustomVoice.
   */
  instructions?: string;
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
  /**
   * Language code. The codes depend on the model, for example `en-us` or `en-gb` (Kokoro), `en` (Chatterbox),
   * `English` (Qwen3). Defaults to the model's default language from the model catalog.
   */
  lang?: string;
  /** TTS mode. Detected from the model catalog when omitted (`voice_design` for Qwen3 VoiceDesign). */
  mode?: DeapiSpeechMode;
  /** Voice description (VoiceDesign) or style instruction (CustomVoice). Overrides the constructor `instructions`. */
  instructions?: string;
  /** Alias of `instructions`, using the API field name. */
  instruct?: string;
  /** Speaking speed, usually between 0.5 and 2. Defaults to the model's default (1). */
  speed?: number;
  /** Output format. Defaults to the model's default (`mp3`). */
  format?: string;
  /** Output sample rate. Defaults to the model's default (24000). */
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
  info?: {
    defaults?: Record<string, unknown> | null;
    features?: Record<string, unknown> | null;
  } | null;
}

interface DeapiModelPage {
  data?: DeapiModel[];
  meta?: { last_page?: number };
}

const FAILED_STATUSES = new Set(['error', 'failed', 'cancelled', 'canceled']);

/** Transcription results are JSON (`{ "text": ... }`) or plain text, depending on the model. */
function extractTranscript(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { text?: unknown };
      if (typeof parsed.text === 'string') return parsed.text.trim();
    } catch {
      // Not JSON: return the raw text.
    }
  }
  return trimmed;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * deAPI voice provider for Mastra: text-to-speech (Kokoro, Chatterbox, Qwen3 TTS)
 * and speech-to-text (Whisper Large V3, CTranslate2) on open-source models.
 *
 * Create an API key at https://app.deapi.ai/settings/api-keys and set `DEAPI_API_KEY`.
 */
export class DeapiVoice extends MastraVoice {
  private readonly speechApiKey: string;
  private readonly listeningApiKey: string;
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  /** Speaker passed to the constructor. It applies only to the configured speech model. */
  private readonly configuredSpeaker?: string;
  private readonly instructions?: string;
  private modelCache?: { at: number; models: Promise<DeapiModel[]> };

  constructor({
    speechModel,
    listeningModel,
    speaker,
    instructions,
    baseUrl,
    pollIntervalMs,
    timeoutMs,
    fetch: fetchImpl,
  }: DeapiVoiceConfig = {}) {
    const defaultApiKey = process.env.DEAPI_API_KEY;
    const speechModelName = speechModel?.name ?? DEFAULT_SPEECH_MODEL;

    super({
      speechModel: {
        name: speechModelName,
        apiKey: speechModel?.apiKey ?? defaultApiKey,
      },
      listeningModel: {
        name: listeningModel?.name ?? DEFAULT_LISTENING_MODEL,
        apiKey: listeningModel?.apiKey ?? defaultApiKey,
      },
      speaker: speaker ?? (speechModelName === DEFAULT_SPEECH_MODEL ? KOKORO_DEFAULTS.voice : undefined),
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
    this.configuredSpeaker = speaker;
    this.instructions = instructions;
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.pollIntervalMs = pollIntervalMs ?? 1000;
    this.timeoutMs = timeoutMs ?? 300_000;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
  }

  /** Lists the voices of the current speech model, read from deAPI's model catalog. */
  async getSpeakers(): Promise<DeapiSpeaker[]> {
    const modelSlug = this.speechModel?.name ?? DEFAULT_SPEECH_MODEL;
    const model = await this.findModel(modelSlug);
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

    const { speaker, model, lang, mode, instructions, instruct, speed, format, sampleRate, ...rest } = options ?? {};
    const instanceModel = this.speechModel?.name ?? DEFAULT_SPEECH_MODEL;
    const modelSlug = model ?? instanceModel;

    // Explicit values win: call options first, then the constructor speaker (only for the model it was set for).
    let voice = speaker ?? (modelSlug === instanceModel ? this.configuredSpeaker : undefined);
    let language = lang;
    let resolvedMode = mode;
    let resolvedFormat = format;
    let resolvedSampleRate = sampleRate;
    let resolvedSpeed = speed;

    if (modelSlug === DEFAULT_SPEECH_MODEL) {
      voice ??= KOKORO_DEFAULTS.voice;
      language ??= KOKORO_DEFAULTS.lang;
    } else if (language === undefined || resolvedMode === undefined || (voice === undefined && resolvedMode === 'custom_voice')) {
      // Every other model has its own languages and voices: fill the gaps from the model catalog.
      const catalogModel = await this.findModel(modelSlug);
      if (!catalogModel) {
        throw new Error(
          `deAPI model "${modelSlug}" was not found in the model catalog. Check the model name or pass lang and speaker explicitly.`,
        );
      }
      const defaults = catalogModel.info?.defaults ?? {};
      const features = catalogModel.info?.features ?? {};
      if (resolvedMode === undefined && features.supports_custom_voice === false && features.supports_voice_design === true) {
        resolvedMode = 'voice_design';
      }
      language ??= stringOrUndefined(defaults.lang);
      if (resolvedMode !== 'voice_design') voice ??= stringOrUndefined(defaults.voice);
      resolvedFormat ??= stringOrUndefined(defaults.format);
      resolvedSampleRate ??= numberOrUndefined(defaults.sample_rate);
      resolvedSpeed ??= numberOrUndefined(defaults.speed);
      if (language === undefined) {
        throw new Error(`deAPI model "${modelSlug}" has no default language in the model catalog. Pass lang explicitly.`);
      }
      if (voice === undefined && (resolvedMode ?? 'custom_voice') === 'custom_voice') {
        throw new Error(`deAPI model "${modelSlug}" has no default voice in the model catalog. Pass speaker explicitly.`);
      }
    }

    const instruction = instructions ?? instruct ?? this.instructions;
    if (resolvedMode === 'voice_design' && !instruction) {
      throw new Error(
        `deAPI model "${modelSlug}" creates a voice from a description. Pass instructions, for example "A warm female voice with a British accent".`,
      );
    }

    const payload: Record<string, unknown> = {
      text,
      model: modelSlug,
      lang: language,
      format: resolvedFormat ?? DEFAULT_FORMAT,
      sample_rate: resolvedSampleRate ?? DEFAULT_SAMPLE_RATE,
      speed: resolvedSpeed ?? DEFAULT_SPEED,
    };
    if (voice !== undefined) payload.voice = voice;
    if (resolvedMode !== undefined) payload.mode = resolvedMode;
    if (instruction) payload.instruct = instruction;
    Object.assign(payload, rest);

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
      return extractTranscript(job.result);
    }
    if (!job.result_url) {
      throw new Error('deAPI transcription job finished without a transcript.');
    }
    return extractTranscript((await this.download(job.result_url)).toString('utf-8'));
  }

  /** Finds a model in the catalog. The catalog is cached for 10 minutes per instance. */
  private async findModel(slug: string): Promise<DeapiModel | undefined> {
    if (!this.modelCache || Date.now() - this.modelCache.at > MODEL_CACHE_TTL_MS) {
      const models = this.fetchModels();
      this.modelCache = { at: Date.now(), models };
      // Do not keep a failed lookup in the cache.
      models.catch(() => {
        if (this.modelCache?.models === models) this.modelCache = undefined;
      });
    }
    return (await this.modelCache.models).find(m => m.slug === slug);
  }

  private async fetchModels(): Promise<DeapiModel[]> {
    const models: DeapiModel[] = [];
    for (let page = 1; ; page++) {
      const body = await this.request<DeapiModelPage>(this.speechApiKey, `/models?per_page=${MODELS_PER_PAGE}&page=${page}`);
      const data = body.data ?? [];
      models.push(...data);
      if (data.length === 0 || page >= (body.meta?.last_page ?? 1)) return models;
    }
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
