import { encodeMulaw, encodeWav, wavToMulaw } from './audio.ts';
import type { TraceFn } from './trace.ts';

/** Playable telephony audio: 8 kHz mu-law bytes for the media stream. */
export interface SynthesizedAudio {
  audio: Buffer;
}

/**
 * One logical spoken response. The LLM can deliver several phrases before the
 * response tail; each phrase is pushed as text and all returned audio belongs
 * to the same prosodic response with a single generation ID.
 */
export interface SpeechResponse {
  readonly generation: number;
  pushText(text: string): void;
  finishText(): void;
  audio(): AsyncIterable<Buffer>;
  cancel(reason: string): void;
}

export interface SpeechOptions {
  generation: number;
  language?: string;
  /** Notified when a streaming phrase falls back to the request/response path. */
  onFallback?: (text: string, detail: string) => void;
}

/** Text in, playable audio out. Mirrors the Transcriber/Assistant injection seams. */
export interface Tts {
  synthesize(text: string): Promise<SynthesizedAudio>;
  /**
   * Optional live path: yields playable mu-law chunks as the provider
   * generates them, so the first words reach the Caller before the whole
   * sentence is synthesized. The session falls back to `synthesize` when this
   * is absent, or when it fails before playing any chunk.
   */
  synthesizeStream?(text: string): AsyncIterable<Buffer>;
  /**
   * Incremental response path: one logical response accepts phrase-sized text
   * and streams provider audio as it arrives. Preferred over the whole-string
   * path when present.
   */
  begin?(options: SpeechOptions): SpeechResponse;
  /** Release any provider socket the implementation holds. */
  close?(): void;
}

/** Pull-side buffer queue shared by streaming speech adapters. */
export class BufferQueue {
  private readonly chunks: Buffer[] = [];
  private waiter: (() => void) | null = null;
  private done = false;
  private error: Error | null = null;

  push(chunk: Buffer): void {
    if (this.done) return;
    this.chunks.push(chunk);
    this.wake();
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    this.wake();
  }

  fail(err: Error): void {
    if (this.done) return;
    this.error = err;
    this.done = true;
    this.wake();
  }

  get settled(): boolean {
    return this.done;
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  async *drain(): AsyncGenerator<Buffer> {
    for (;;) {
      while (this.chunks.length > 0) yield this.chunks.shift()!;
      if (this.error) throw this.error;
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

/**
 * Response session for a provider without a persistent incremental socket:
 * each pushed phrase is synthesized in order (streaming when the provider
 * supports it, request/response otherwise) and its audio queues immediately.
 * A stream that fails before yielding falls back to the one-shot call for
 * that phrase. The single queue keeps the whole response one playback unit.
 */
export function bufferedSpeech(tts: Tts, options: SpeechOptions): SpeechResponse {
  const queue = new BufferQueue();
  let pending: Promise<void> = Promise.resolve();
  let finished = false;
  let cancelled = false;

  const oneShot = async function* oneShot(text: string): AsyncGenerator<Buffer> {
    yield (await tts.synthesize(text)).audio;
  };

  const speakPhrase = (phrase: string): void => {
    pending = pending
      .then(async () => {
        if (cancelled) return;
        if (tts.synthesizeStream) {
          let chunks = 0;
          try {
            for await (const chunk of tts.synthesizeStream(phrase)) {
              if (cancelled) return;
              chunks += 1;
              queue.push(chunk);
            }
            return;
          } catch (err) {
            if (cancelled) return;
            if (chunks > 0) throw err;
            options.onFallback?.(phrase, err instanceof Error ? err.message : String(err));
          }
        }
        for await (const chunk of oneShot(phrase)) {
          if (cancelled) return;
          queue.push(chunk);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) queue.fail(err instanceof Error ? err : new Error(String(err)));
      });
  };

  return {
    generation: options.generation,
    pushText(text: string): void {
      if (cancelled || finished) return;
      if (text.trim()) speakPhrase(text.trim());
    },
    finishText(): void {
      if (cancelled || finished) return;
      finished = true;
      void pending.then(() => queue.end());
    },
    audio: () => queue.drain(),
    cancel(): void {
      cancelled = true;
      queue.end();
    },
  };
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
  private readonly onTrace?: TraceFn;

  constructor(opts: {
    apiKey: string;
    baseUrl?: string;
    model?: string;
    voice?: string;
    responseFormat?: 'wav' | 'pcm';
    pcmSampleRate?: number;
    fetchFn?: typeof fetch;
    onTrace?: TraceFn;
  }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? 'https://openrouter.ai/api/v1';
    this.model = opts.model ?? 'qwen/qwen-audio-3.0-tts-flash';
    this.voice = opts.voice ?? 'loongjohn';
    this.responseFormat = opts.responseFormat ?? 'wav';
    this.pcmSampleRate = opts.pcmSampleRate ?? 24000;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.onTrace = opts.onTrace;
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

  private request(text: string): Promise<Response> {
    return this.fetchFn(`${this.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: this.model, voice: this.voice, input: text, response_format: this.responseFormat }),
    });
  }

  async synthesize(text: string): Promise<SynthesizedAudio> {
    const started = Date.now();
    this.onTrace?.({ component: 'tts', event: 'rest-start', chars: text.length, model: this.model });
    try {
      const res = await this.request(text);
      if (!res.ok) throw new Error(`tts-http-${res.status}`);
      const raw = Buffer.from(await res.arrayBuffer());
      const audio =
        this.responseFormat === 'pcm'
          ? wavToMulaw(encodeWav(new Int16Array(raw.buffer, raw.byteOffset, (raw.length - (raw.length % 2)) / 2), this.pcmSampleRate))
          : wavToMulaw(raw);
      this.onTrace?.({ component: 'tts', event: 'rest-done', ms: Date.now() - started, bytes: audio.length });
      return { audio };
    } catch (err) {
      this.onTrace?.({
        component: 'tts',
        event: 'rest-error',
        ms: Date.now() - started,
        detail: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * HTTP-body streaming: raw PCM chunks are converted to 8 kHz mu-law as they
   * arrive instead of waiting for the full response body. WAV responses still
   * need the complete body (header + trailer), so they yield once.
   */
  async *synthesizeStream(text: string): AsyncGenerator<Buffer> {
    const started = Date.now();
    this.onTrace?.({ component: 'tts', event: 'rest-start', chars: text.length, model: this.model, stream: true });
    try {
      const res = await this.request(text);
      if (!res.ok) throw new Error(`tts-http-${res.status}`);
      if (this.responseFormat === 'wav' || !res.body) {
        const raw = Buffer.from(await res.arrayBuffer());
        const audio = this.responseFormat === 'pcm' ? wavToMulaw(encodeWav(new Int16Array(raw.buffer, raw.byteOffset, (raw.length - (raw.length % 2)) / 2), this.pcmSampleRate)) : wavToMulaw(raw);
        this.onTrace?.({ component: 'tts', event: 'rest-done', ms: Date.now() - started, bytes: audio.length });
        yield audio;
        return;
      }
      const resampler = new StreamingPcmToMulaw(this.pcmSampleRate, 8000);
      let bytes = 0;
      let carry = Buffer.alloc(0);
      for await (const piece of res.body as unknown as AsyncIterable<Uint8Array>) {
        const combined = carry.length > 0 ? Buffer.concat([carry, Buffer.from(piece)]) : Buffer.from(piece);
        const even = combined.length - (combined.length % 2);
        if (even === 0) {
          carry = combined;
          continue;
        }
        const samples = new Int16Array(combined.buffer, combined.byteOffset, even / 2);
        const out = resampler.push(samples);
        carry = Buffer.from(combined.subarray(even));
        if (out.length > 0) {
          bytes += out.length;
          yield out;
        }
      }
      const tail = resampler.flush();
      if (tail.length > 0) {
        bytes += tail.length;
        yield tail;
      }
      this.onTrace?.({ component: 'tts', event: 'rest-done', ms: Date.now() - started, bytes, stream: true });
    } catch (err) {
      this.onTrace?.({
        component: 'tts',
        event: 'rest-error',
        ms: Date.now() - started,
        detail: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  begin(options: SpeechOptions): SpeechResponse {
    return bufferedSpeech(this, options);
  }
}

/**
 * Stateful linear PCM resampler for streaming bodies. Keeps the fractional
 * position and the last input sample between chunks so output is continuous.
 */
export class StreamingPcmToMulaw {
  private carry: Int16Array = new Int16Array(0);
  private base = 0;
  private nextOut = 0;
  private readonly ratio: number;

  constructor(fromRate: number, toRate: number) {
    this.ratio = fromRate / toRate;
  }

  push(pcm: Int16Array): Buffer {
    if (pcm.length === 0) return Buffer.alloc(0);
    const input = this.carry.length > 0 ? concatSamples(this.carry, pcm) : pcm;
    const out: number[] = [];
    for (;;) {
      const pos = this.nextOut * this.ratio - this.base;
      if (Math.floor(pos) + 1 >= input.length) break;
      const lo = Math.floor(pos);
      const frac = pos - lo;
      out.push(Math.round(input[lo]! * (1 - frac) + input[lo + 1]! * frac));
      this.nextOut += 1;
    }
    const drop = Math.max(0, Math.min(input.length, Math.floor(this.nextOut * this.ratio - this.base)));
    this.base += drop;
    this.carry = input.slice(drop);
    return encodeMulaw(Int16Array.from(out));
  }

  flush(): Buffer {
    const out: number[] = [];
    const last = this.carry.length > 0 ? this.carry[this.carry.length - 1]! : 0;
    for (;;) {
      const pos = this.nextOut * this.ratio - this.base;
      const lo = Math.floor(pos);
      if (lo >= this.carry.length) break;
      const hi = lo + 1;
      const frac = pos - lo;
      out.push(Math.round(this.carry[lo]! * (1 - frac) + (hi < this.carry.length ? this.carry[hi]! : last) * frac));
      this.nextOut += 1;
    }
    this.carry = new Int16Array(0);
    this.base = 0;
    this.nextOut = 0;
    return encodeMulaw(Int16Array.from(out));
  }
}

function interpolate(input: Int16Array, pos: number): number {
  const lo = Math.floor(pos);
  const frac = pos - lo;
  return Math.round(input[lo]! * (1 - frac) + input[lo + 1]! * frac);
}

function concatSamples(a: Int16Array, b: Int16Array): Int16Array {
  const out = new Int16Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
