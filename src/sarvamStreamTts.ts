import { BufferQueue, type SpeechOptions, type SpeechResponse, type SynthesizedAudio, type Tts } from './tts.ts';
import { clip, type TraceFn } from './trace.ts';
import { defaultSocket, type RealtimeSocket, type RealtimeSocketFactory } from './ws.ts';

/** Sarvam streaming TTS (`GET {baseUrl}/text-to-speech/ws`) — Bulbul dialect. */
export interface SarvamStreamTtsConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  speaker: string;
  languageCode: string;
  /** Provider text buffering; synthesis starts once this much text is queued. */
  minBufferSize?: number;
  maxChunkLength?: number;
  /** Silence after a flush, before more audio or the final event, fails the utterance. */
  idleTimeoutMs?: number;
  /** Keepalive; Sarvam closes sockets idle for a minute. */
  pingIntervalMs?: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 5000;
const PING_INTERVAL_MS = 15_000;
/** The media stream is 8 kHz mu-law, so ask Sarvam for exactly that. */
const TELEPHONY_SAMPLE_RATE = 8000;

function streamUrl(baseUrl: string, cfg: SarvamStreamTtsConfig): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/text-to-speech/ws`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('model', cfg.model);
  url.searchParams.set('send_completion_event', 'true');
  return url.toString();
}

interface ActiveResponse {
  generation: number;
  queue: BufferQueue;
  startedAt: number;
  firstPushAt: number;
  firstAudioAt: number;
  chars: number;
  chunks: number;
  bytes: number;
  started: boolean;
  done: boolean;
  cancelled: boolean;
}

/**
 * Sarvam's text-to-speech WebSocket. One instance serves one call: audio is
 * requested as 8 kHz mu-law so each server chunk is forwarded to the media
 * stream untouched. One persistent socket carries every response; phrase-sized
 * text is pushed as the LLM produces it and a single `flush` marks the tail.
 * Cancellation drops the socket so late audio can never play; the next
 * response lazily opens a fresh one. A socket that fails or idles out makes
 * later utterances fall back to the REST `synthesize` path.
 */
export class SarvamStreamingTts implements Tts {
  private readonly cfg: SarvamStreamTtsConfig;
  private readonly fallback: Tts | undefined;
  private readonly connect: RealtimeSocketFactory;
  private readonly idleTimeoutMs: number;
  private readonly pingIntervalMs: number;
  private readonly onTrace?: TraceFn;
  private socket: RealtimeSocket | null = null;
  private outbox: string[] = [];
  private pingTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private ready = false;
  private failed = false;
  private closed = false;
  private response: ActiveResponse | null = null;

  constructor(opts: {
    config: SarvamStreamTtsConfig;
    /** REST implementation used when `synthesize` is requested or the stream dies. */
    fallback?: Tts;
    connect?: RealtimeSocketFactory;
    onTrace?: TraceFn;
  }) {
    this.cfg = opts.config;
    this.fallback = opts.fallback;
    this.idleTimeoutMs = opts.config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.pingIntervalMs = opts.config.pingIntervalMs ?? PING_INTERVAL_MS;
    this.connect = opts.connect ?? defaultSocket;
    this.onTrace = opts.onTrace;
    this.openSocket();
  }

  private openSocket(): void {
    const sock = this.connect(streamUrl(this.cfg.baseUrl, this.cfg), {
      'api-subscription-key': this.cfg.apiKey,
    });
    this.socket = sock;
    this.ready = false;
    this.outbox = [];
    sock.onOpen(() => {
      if (this.closed || this.failed || this.socket !== sock) return;
      this.ready = true;
      this.onTrace?.({ component: 'tts', event: 'stream-open', model: this.cfg.model, speaker: this.cfg.speaker });
      const data: Record<string, unknown> = {
        model: this.cfg.model,
        language_code: this.cfg.languageCode,
        speaker: this.cfg.speaker,
        speech_sample_rate: TELEPHONY_SAMPLE_RATE,
        output_audio_codec: 'mulaw',
      };
      if (this.cfg.minBufferSize !== undefined) data['min_buffer_size'] = this.cfg.minBufferSize;
      if (this.cfg.maxChunkLength !== undefined) data['max_chunk_length'] = this.cfg.maxChunkLength;
      this.sendRaw(sock, JSON.stringify({ type: 'config', data }));
      for (const queued of this.outbox.splice(0)) this.sendRaw(sock, queued);
    });
    sock.onMessage((data) => this.receive(sock, data));
    sock.onError((err) => {
      if (this.socket !== sock) return;
      this.fail(err);
    });
    sock.onClose((code, reason) => {
      if (this.socket !== sock) return;
      this.onTrace?.({ component: 'tts', event: 'stream-close', code, reason });
      if (!this.closed) this.fail(new Error('sarvam-tts-stream-closed'));
    });
    if (this.pingTimer === null) {
      this.pingTimer = setInterval(() => {
        if (!this.closed && !this.failed && this.ready && this.socket) this.send({ type: 'ping' });
      }, this.pingIntervalMs);
      this.pingTimer.unref?.();
    }
  }

  /** Text in, complete 8 kHz mu-law audio out via the REST fallback. */
  async synthesize(text: string): Promise<SynthesizedAudio> {
    if (!this.fallback) throw new Error('sarvam-tts-no-fallback');
    return this.fallback.synthesize(text);
  }

  /** One logical response; phrase text is pushed and a single flush ends it. */
  begin(options: SpeechOptions): SpeechResponse {
    if (this.closed || this.failed || !this.socket) throw new Error('sarvam-tts-stream-unavailable');
    const previous = this.response;
    if (previous && !previous.done && !previous.cancelled) this.cancelResponse(previous, 'superseded');
    const response: ActiveResponse = {
      generation: options.generation,
      queue: new BufferQueue(),
      startedAt: Date.now(),
      firstPushAt: 0,
      firstAudioAt: 0,
      chars: 0,
      chunks: 0,
      bytes: 0,
      started: false,
      done: false,
      cancelled: false,
    };
    this.response = response;
    return {
      generation: response.generation,
      pushText: (text: string) => this.pushText(response, text),
      finishText: () => this.finishText(response),
      audio: () => response.queue.drain(),
      cancel: (reason: string) => this.cancelResponse(response, reason),
    };
  }

  /** Legacy one-string utterance on top of the response session. */
  async *synthesizeStream(text: string): AsyncGenerator<Buffer> {
    const response = this.begin({ generation: 0 });
    response.pushText(text);
    response.finishText();
    yield* response.audio();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const response = this.response;
    this.onTrace?.({ component: 'tts', event: 'closed', pending: response !== null && !response.done });
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.clearIdleTimer();
    this.response = null;
    if (response) {
      response.queue.fail(new Error('sarvam-tts-stream-closed'));
    }
    try {
      this.socket?.close();
    } catch {
      // Socket already gone; nothing left to release.
    }
  }

  private pushText(response: ActiveResponse, text: string): void {
    if (this.closed || this.failed || response.done || response.cancelled || text.length === 0) return;
    if (!response.started) {
      response.started = true;
      response.firstPushAt = Date.now();
      this.onTrace?.({
        component: 'tts',
        event: 'utterance-start',
        generation: response.generation,
        chars: text.length,
      });
    }
    response.chars += text.length;
    this.send({ type: 'text', data: { text } });
  }

  private finishText(response: ActiveResponse): void {
    if (this.closed || this.failed || response.done || response.cancelled) return;
    if (!response.started) return;
    this.onTrace?.({
      component: 'tts',
      event: 'request-or-flush',
      generation: response.generation,
      chars: response.chars,
    });
    this.send({ type: 'flush' });
    this.armIdleTimer(response);
  }

  private cancelResponse(response: ActiveResponse, reason: string): void {
    if (response.done || response.cancelled) return;
    response.cancelled = true;
    response.queue.end();
    this.onTrace?.({
      component: 'tts',
      event: 'cancelled',
      generation: response.generation,
      reason,
      chars: response.chars,
      chunks: response.chunks,
    });
    if (this.response === response) this.response = null;
    this.clearIdleTimer();
    // Dropping the socket guarantees no late chunk can be mistaken for the next
    // response; the next begin() opens a fresh one through the factory.
    const sock = this.socket;
    this.socket = null;
    this.ready = false;
    this.outbox = [];
    try {
      sock?.close();
    } catch {
      // Socket already gone.
    }
    if (!this.closed && !this.failed) this.openSocket();
  }

  private send(message: Record<string, unknown>): void {
    if (this.closed || this.failed || !this.socket) return;
    const data = JSON.stringify(message);
    if (this.ready) this.sendRaw(this.socket, data);
    else this.outbox.push(data);
  }

  private sendRaw(sock: RealtimeSocket, data: string): void {
    try {
      sock.send(data);
    } catch (err) {
      if (this.socket === sock) this.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private receive(sock: RealtimeSocket, data: string): void {
    if (this.socket !== sock) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const msg = parsed as {
      type?: unknown;
      data?: { audio?: unknown; event_type?: unknown; code?: unknown; message?: unknown };
    };
    if (msg.type === 'audio') {
      const response = this.response;
      if (!response || response.done || response.cancelled) return;
      const raw = msg.data?.audio;
      if (typeof raw !== 'string' || raw.length === 0) return;
      const chunk = Buffer.from(raw, 'base64');
      if (response.chunks === 0) {
        response.firstAudioAt = Date.now();
        this.onTrace?.({
          component: 'tts',
          event: 'first-audio',
          generation: response.generation,
          ms: response.firstAudioAt - response.startedAt,
        });
      }
      response.chunks += 1;
      response.bytes += chunk.length;
      this.armIdleTimer(response);
      response.queue.push(chunk);
      return;
    }
    if (msg.type === 'event') {
      if (msg.data?.event_type !== 'final') return;
      const response = this.response;
      if (!response || response.cancelled) return;
      response.done = true;
      this.clearIdleTimer();
      this.onTrace?.({
        component: 'tts',
        event: 'utterance-done',
        generation: response.generation,
        ms: Date.now() - response.startedAt,
        firstMs: response.firstAudioAt > 0 ? response.firstAudioAt - response.startedAt : undefined,
        chunks: response.chunks,
        bytes: response.bytes,
      });
      response.queue.end();
      return;
    }
    if (msg.type === 'error') {
      const response = this.response;
      this.clearIdleTimer();
      const code = msg.data?.code;
      const detail = typeof code === 'number' ? `sarvam-tts-stream-error-${code}` : 'sarvam-tts-stream-error';
      this.onTrace?.({
        component: 'tts',
        event: 'provider-error',
        code,
        detail: clip(typeof msg.data?.message === 'string' ? msg.data.message : '', 200),
      });
      response?.queue.fail(new Error(detail));
      if (response) response.done = true;
    }
  }

  private fail(err: Error): void {
    if (this.failed || this.closed) return;
    this.failed = true;
    this.onTrace?.({ component: 'tts', event: 'stream-error', detail: err.message });
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.clearIdleTimer();
    const response = this.response;
    this.response = null;
    response?.queue.fail(err);
    try {
      this.socket?.close();
    } catch {
      // Socket already gone.
    }
  }

  private armIdleTimer(response: ActiveResponse): void {
    this.clearIdleTimer();
    if (this.idleTimeoutMs <= 0) return;
    // Deliberately not unref'd: a pending utterance is waiting on this timer.
    this.idleTimer = setTimeout(() => {
      if (this.response !== response || response.done || response.cancelled) return;
      this.onTrace?.({ component: 'tts', event: 'idle-timeout', ms: this.idleTimeoutMs });
      this.fail(new Error('sarvam-tts-stream-timeout'));
    }, this.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
