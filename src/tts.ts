import { wavToMulaw } from './audio.ts';

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
}

/** First implementation: OpenAI TTS, reusing the key already configured for STT. */
export class OpenAiTts implements Tts {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: {
    apiKey: string;
    baseUrl?: string;
    model?: string;
    voice?: string;
    fetchFn?: typeof fetch;
  }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1';
    this.model = opts.model ?? 'tts-1';
    this.voice = opts.voice ?? 'alloy';
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  config(): TtsConfig {
    return { apiKey: this.apiKey, baseUrl: this.baseUrl, model: this.model, voice: this.voice };
  }

  async synthesize(text: string): Promise<SynthesizedAudio> {
    const res = await this.fetchFn(`${this.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: this.model, voice: this.voice, input: text, response_format: 'wav' }),
    });
    if (!res.ok) throw new Error(`tts-http-${res.status}`);
    const wav = Buffer.from(await res.arrayBuffer());
    return { audio: wavToMulaw(wav) };
  }
}
