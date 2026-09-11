import { encodeWav, wavToMulaw } from './audio.ts';

/** Playable telephony audio: 8 kHz mu-law bytes for the media stream. */
export interface SynthesizedAudio {
  audio: Buffer;
}

/** Text in, playable audio out. Mirrors the Transcriber/Assistant injection seams. */
export interface Tts {
  synthesize(text: string): Promise<SynthesizedAudio>;
}

export interface TtsConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  voice: string;
  responseFormat: 'wav' | 'pcm';
  /** Sample rate of raw `pcm` responses; OpenRouter advertises it in the Content-Type. */
  pcmSampleRate: number;
}

/**
 * First implementation: OpenAI Audio Speech dialect (`POST {baseUrl}/audio/speech`).
 * Defaults to the OpenRouter TTS endpoint, which only serves `mp3`/`pcm` —
 * `pcm` is used because this pipeline has no mp3 decoder; raw samples are
 * wrapped in a WAV header at `pcmSampleRate` and reuse the wav→mulaw path.
 */
export class OpenAiTts implements Tts {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly responseFormat: 'wav' | 'pcm';
  private readonly pcmSampleRate: number;
  private readonly fetchFn: typeof fetch;

  constructor(opts: {
    apiKey: string;
    baseUrl?: string;
    model?: string;
    voice?: string;
    responseFormat?: 'wav' | 'pcm';
    pcmSampleRate?: number;
    fetchFn?: typeof fetch;
  }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? 'https://openrouter.ai/api/v1';
    this.model = opts.model ?? 'qwen/qwen-audio-3.0-tts-flash';
    this.voice = opts.voice ?? 'loongjohn';
    this.responseFormat = opts.responseFormat ?? 'wav';
    this.pcmSampleRate = opts.pcmSampleRate ?? 24000;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  config(): TtsConfig {
    return {
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      model: this.model,
      voice: this.voice,
      responseFormat: this.responseFormat,
      pcmSampleRate: this.pcmSampleRate,
    };
  }

  async synthesize(text: string): Promise<SynthesizedAudio> {
    const res = await this.fetchFn(`${this.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: this.model, voice: this.voice, input: text, response_format: this.responseFormat }),
    });
    if (!res.ok) throw new Error(`tts-http-${res.status}`);
    const raw = Buffer.from(await res.arrayBuffer());
    if (this.responseFormat === 'pcm') {
      const even = raw.length - (raw.length % 2);
      const pcm = new Int16Array(raw.buffer, raw.byteOffset, even / 2);
      return { audio: wavToMulaw(encodeWav(pcm, this.pcmSampleRate)) };
    }
    return { audio: wavToMulaw(raw) };
  }
}
