import type { Transcription } from './app.ts';
import type { PartialTranscript, RealtimeStt } from './realtimeStt.ts';
import type { TraceFn } from './trace.ts';
import { defaultSocket, type RealtimeSocket, type RealtimeSocketFactory } from './ws.ts';

/** OpenAI Realtime transcription (`gpt-live-transcribe`). */
export interface OpenAiRealtimeConfig {
  apiKey: string;
  /** Full transcription websocket URL, e.g. `wss://api.openai.com/v1/realtime?intent=transcription`. */
  url: string;
  model: string;
  /** Latency/accuracy tradeoff: `minimal` | `low` | `medium` | `high` | `xhigh`. */
  delay: string;
  /** Clinic terminology hints sent at session start. */
  keywords?: string[];
  languages?: string[];
  /** How long `finalize` waits for the completed event before rejecting to REST. */
  finalTimeoutMs?: number;
  /** Pre-speech audio held for the utterance start; 8 kHz mulaw is ~8 bytes/ms. */
  preRollBytes?: number;
}

const DEFAULT_FINAL_TIMEOUT_MS = 4000;
const DEFAULT_PRE_ROLL_BYTES = 8000;
/** 8 kHz mulaw: 8 bytes per millisecond. */
const BYTES_PER_MS = 8;

/** Read a non-empty string field off a parsed event; null when absent or mistyped. */
function stringField(record: object, field: string): string | null {
  const value = (record as Record<string, unknown>)[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * One call's streaming transcription channel over OpenAI's Realtime API.
 *
 * The model rejects server turn detection, so the channel is manual: audio is
 * appended only between the local detector's speech start and its boundary,
 * keeping the billed audio close to the speech itself. Transcription deltas
 * stream while the Caller speaks; they accumulate per conversation item and
 * emit through the partial channel, while `finalize` commits the buffer and
 * resolves on `conversation.item.input_audio_transcription.completed`.
 */
export class OpenAiRealtimeStt implements RealtimeStt {
  /** The live transcription model streams deltas as speech arrives. */
  readonly partials = true;
  private readonly socket: RealtimeSocket;
  private readonly finalTimeoutMs: number;
  private readonly preRollBytes: number;
  private readonly onTrace?: TraceFn;
  private readonly pendingAudio: Buffer[] = [];
  private readonly outbox: string[] = [];
  /** Cumulative transcript per conversation item, emitted as deltas arrive. */
  private readonly itemTexts = new Map<string, string>();
  /** Item ids whose deltas must never emit again: completed or superseded. */
  private readonly staleItems = new Set<string>();
  /** The conversation item currently receiving transcription deltas. */
  private activeItemId: string | null = null;
  private partialHandler: ((partial: PartialTranscript) => void) | null = null;
  private pendingBytes = 0;
  private ready = false;
  private failed = false;
  private closed = false;
  private speechOpen = false;
  /** Audio appended since the last commit. */
  private utteranceBytes = 0;
  /** Audio appended over the whole call, for the cost trace. */
  private totalBytes = 0;
  /** Admitted partials for the utterance under capture, for the final trace. */
  private partialCount = 0;
  private speechStartedAt = 0;
  private waiting: {
    resolve: (tx: Transcription) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;

  constructor(opts: { config: OpenAiRealtimeConfig; connect?: RealtimeSocketFactory; onTrace?: TraceFn }) {
    this.finalTimeoutMs = opts.config.finalTimeoutMs ?? DEFAULT_FINAL_TIMEOUT_MS;
    this.preRollBytes = opts.config.preRollBytes ?? DEFAULT_PRE_ROLL_BYTES;
    this.onTrace = opts.onTrace;
    const update = JSON.stringify({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            transcription: {
              model: opts.config.model,
              delay: opts.config.delay,
              ...(opts.config.keywords && opts.config.keywords.length > 0 ? { keywords: opts.config.keywords } : {}),
              ...(opts.config.languages && opts.config.languages.length > 0 ? { languages: opts.config.languages } : {}),
            },
            turn_detection: null,
          },
        },
      },
    });
    this.socket = (opts.connect ?? defaultSocket)(opts.config.url, {
      Authorization: `Bearer ${opts.config.apiKey}`,
    });
    this.socket.onOpen(() => {
      if (this.closed) return;
      this.ready = true;
      this.socket.send(update);
      this.onTrace?.({
        component: 'stt',
        event: 'open',
        model: opts.config.model,
        delay: opts.config.delay,
        keywords: opts.config.keywords?.length ?? 0,
      });
      for (const data of this.outbox.splice(0)) this.socket.send(data);
    });
    this.socket.onMessage((data) => this.receive(data));
    this.socket.onError((err) => this.fail(err));
    this.socket.onClose((code, reason) => {
      this.onTrace?.({ component: 'stt', event: 'socket-close', code, reason });
      if (!this.closed) this.fail(new Error('openai-realtime-closed'));
    });
  }

  private send(message: Record<string, unknown>): void {
    if (this.closed || this.failed) return;
    const data = JSON.stringify(message);
    if (this.ready) this.socket.send(data);
    else this.outbox.push(data);
  }

  private receive(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const event = (parsed as { type?: unknown }).type;
    if (event === 'input_audio_buffer.committed') {
      // The commit confirms which item is being transcribed; the live model
      // may already have streamed deltas for it, so its accumulation is kept.
      const itemId = stringField(parsed, 'item_id');
      if (itemId !== null) this.adoptItem(itemId);
      this.onTrace?.({ component: 'stt', event: 'committed', itemId });
      return;
    }
    if (event === 'conversation.item.input_audio_transcription.delta') {
      const itemId = stringField(parsed, 'item_id');
      const text = stringField(parsed, 'delta');
      if (itemId === null || text === null) return;
      this.emitPartial(itemId, text);
      return;
    }
    if (event === 'conversation.item.input_audio_transcription.completed') {
      this.finishItem(stringField(parsed, 'item_id'));
      const raw = (parsed as { transcript?: unknown }).transcript;
      const text = typeof raw === 'string' ? raw : '';
      const waiting = this.waiting;
      if (!waiting) return;
      this.waiting = null;
      clearTimeout(waiting.timer);
      this.onTrace?.({
        component: 'stt',
        event: 'final',
        ms: this.speechStartedAt > 0 ? Date.now() - this.speechStartedAt : undefined,
        chars: text.length,
        partials: this.partialCount,
        noSpeech: text.trim().length === 0,
      });
      waiting.resolve({ text, noSpeech: text.trim().length === 0 });
      return;
    }
    if (event === 'conversation.item.input_audio_transcription.failed') {
      this.fail(new Error('openai-realtime-transcription-failed'));
      return;
    }
    if (event === 'error') {
      const error = (parsed as { error?: { message?: unknown; code?: unknown } }).error;
      const detail =
        typeof error?.message === 'string'
          ? error.message
          : typeof error?.code === 'string'
            ? error.code
            : 'openai-realtime-error';
      this.onTrace?.({ component: 'stt', event: 'error', detail });
      this.fail(new Error(detail));
    }
  }

  /** The committed item becomes the only item still allowed to emit partials. */
  private adoptItem(itemId: string): void {
    if (this.staleItems.has(itemId)) return;
    if (this.activeItemId !== null && this.activeItemId !== itemId) this.retire(this.activeItemId);
    this.activeItemId = itemId;
  }

  /**
   * One delta for `itemId`: accumulate per conversation item and emit the
   * cumulative text. A delta for a finished or superseded item is dropped, so a
   * late delta can never surface as the next utterance's partial.
   */
  private emitPartial(itemId: string, delta: string): void {
    if (this.closed || this.failed || this.staleItems.has(itemId)) return;
    if (this.activeItemId !== itemId) {
      if (this.activeItemId !== null) this.retire(this.activeItemId);
      this.activeItemId = itemId;
    }
    const text = (this.itemTexts.get(itemId) ?? '') + delta;
    this.itemTexts.set(itemId, text);
    this.partialCount += 1;
    this.partialHandler?.({ text });
  }

  /** Stop emitting for an item and forget its accumulation. */
  private retire(itemId: string): void {
    this.staleItems.add(itemId);
    this.itemTexts.delete(itemId);
  }

  /** A completed item is finished: its late deltas are never emitted again. */
  private finishItem(itemId: string | null): void {
    if (itemId === null) return;
    this.retire(itemId);
    if (this.activeItemId === itemId) this.activeItemId = null;
  }

  private fail(err: Error): void {
    if (this.failed) return;
    this.failed = true;
    this.onTrace?.({ component: 'stt', event: 'stream-error', detail: err.message });
    const waiting = this.waiting;
    this.waiting = null;
    if (waiting) {
      clearTimeout(waiting.timer);
      waiting.reject(err);
    }
    try {
      this.socket.close();
    } catch {
      // Socket already gone.
    }
  }

  private append(mulaw: Buffer): void {
    this.utteranceBytes += mulaw.length;
    this.totalBytes += mulaw.length;
    this.send({ type: 'input_audio_buffer.append', audio: mulaw.toString('base64') });
  }

  pushAudio(mulaw: Buffer): void {
    if (this.closed || this.failed || mulaw.length === 0) return;
    if (this.speechOpen) {
      this.append(mulaw);
      return;
    }
    this.pendingAudio.push(mulaw);
    this.pendingBytes += mulaw.length;
    // Keep only the recent pre-roll: a long silence before speech is never billed.
    while (this.pendingBytes > this.preRollBytes && this.pendingAudio.length > 1) {
      this.pendingBytes -= this.pendingAudio.shift()!.length;
    }
  }

  /** Subscribe the session's partial consumer: cumulative text per item. */
  onPartial(handler: (partial: PartialTranscript) => void): void {
    this.partialHandler = handler;
  }

  speechStart(): void {
    if (this.closed || this.failed || this.speechOpen) return;
    this.speechOpen = true;
    this.speechStartedAt = Date.now();
    this.partialCount = 0;
    // The previous item's late deltas must never surface as this utterance's
    // partials; only a new item's deltas may emit from here on.
    for (const itemId of this.itemTexts.keys()) this.staleItems.add(itemId);
    this.itemTexts.clear();
    this.activeItemId = null;
    const bufferedBytes = this.pendingBytes;
    const buffered = this.pendingAudio.splice(0);
    this.pendingBytes = 0;
    for (const chunk of buffered) this.append(chunk);
    this.onTrace?.({ component: 'stt', event: 'speech-start', bufferedBytes });
  }

  finalize(): Promise<Transcription> {
    if (this.closed || this.failed || !this.speechOpen || this.utteranceBytes === 0) {
      return Promise.reject(new Error('openai-realtime-not-streaming'));
    }
    if (this.waiting) return Promise.reject(new Error('openai-realtime-finalize-in-flight'));
    const bytes = this.utteranceBytes;
    this.speechOpen = false;
    this.utteranceBytes = 0;
    this.send({ type: 'input_audio_buffer.commit' });
    this.onTrace?.({ component: 'stt', event: 'commit', bytes });
    return new Promise<Transcription>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        this.onTrace?.({ component: 'stt', event: 'final-timeout', ms: this.finalTimeoutMs });
        reject(new Error('openai-realtime-final-timeout'));
      }, this.finalTimeoutMs);
      this.waiting = { resolve, reject, timer };
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onTrace?.({
      component: 'stt',
      event: 'close',
      reason: 'session-end',
      bytes: this.totalBytes,
      audioMs: Math.round(this.totalBytes / BYTES_PER_MS),
    });
    const waiting = this.waiting;
    this.waiting = null;
    if (waiting) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error('openai-realtime-closed'));
    }
    try {
      this.socket.close();
    } catch {
      // Socket already gone.
    }
  }
}
