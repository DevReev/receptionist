import { createHash } from 'node:crypto';
import type { Transcription } from './app.ts';
import type { TraceFn } from './trace.ts';
import { defaultSocket, type RealtimeSocket, type RealtimeSocketFactory } from './ws.ts';

export type { RealtimeSocket, RealtimeSocketFactory } from './ws.ts';

/** Who decides utterance boundaries on this channel. */
export type RealtimeEndpointing = 'manual' | 'vad';

/** Provider VAD boundary event. */
export type VadEvent = 'speech_start' | 'speech_end';

/**
 * One call's live transcription channel. Audio is pushed as the Caller speaks
 * and the final transcript is read at the utterance boundary, so the Turn does
 * not pay a REST round trip after endpointing.
 */
export interface RealtimeStt {
  /** Raw 8 kHz mulaw chunks as they arrive; buffered until `speechStart`. */
  pushAudio(mulaw: Buffer): void;
  /** Our VAD latched: flush buffered audio and open the utterance. */
  speechStart(): void;
  /** Our endpoint fired: finalize the utterance and resolve its transcript. */
  finalize(): Promise<Transcription>;
  /** Boundary-gated context update: terminology hints for later utterances. */
  reconfigure?(context: TranscriptionContext): void;
  /** Subscribe to partials for read-only speculation. */
  onPartial?(handler: (partial: PartialTranscript) => void): void;
  /** Provider boundary events; present only when the provider owns boundaries. */
  onVadEvent?(handler: (event: VadEvent) => void): void;
  /** `vad` when this channel owns utterance boundaries. */
  readonly endpointing?: RealtimeEndpointing;
  /** Switch boundary ownership; applied at the next utterance boundary. */
  setEndpointing?(mode: RealtimeEndpointing): void;
  /** Session over: release the socket. */
  close(): void;
}

/** Structured dialogue context the transcriber can hint on. */
export interface TranscriptionContext {
  /** Comma-separated terminology prompt derived from the clinic guide. */
  prompt?: string;
  languageCode?: string;
}

/** Streaming partial for read-only speculation and early barge-in signals. */
export interface PartialTranscript {
  text: string;
  utteranceIdx?: number;
  language?: string;
}

/** Provider VAD tuning; only sent when `endpointing` is `vad`. */
export interface SarvamVadConfig {
  /** VAD sensitivity (0.0-1.0); provider default 0.3. */
  threshold: number;
  /** Silence in ms marking end-of-turn; provider default 500. */
  silenceMs: number;
  /** Minimum speech in ms to count as an utterance; provider default 250. */
  minSpeechMs: number;
}

export interface SarvamRealtimeConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  languageCode: string;
  streamType: string;
  mode: string;
  encoding: string;
  sampleRate: number;
  /** `vad`: the provider owns boundaries; `manual`: client sends speech_start/speech_end. */
  endpointing: RealtimeEndpointing;
  /** Provider VAD knobs; applied on the connection in `vad` mode. */
  vad?: SarvamVadConfig;
  /** Stable terminology hint applied to finals. */
  prompt?: string;
  /** How long `finalize` waits for `transcript.final` before the caller falls back to REST. */
  finalTimeoutMs?: number;
  /** Pre-speech audio held for the first partial; 8 kHz mulaw is ~8 bytes/ms. */
  preRollBytes?: number;
}

const DEFAULT_FINAL_TIMEOUT_MS = 2000;
const DEFAULT_PRE_ROLL_BYTES = 8000;
/** Server closes idle sessions with code 1008; a ping well under that keeps it open. */
const PING_INTERVAL_MS = 15_000;
/** VAD finals held for a finalize that may never come; older ones are junk. */
const MAX_EARLY_FINALS = 4;

function realtimeUrl(baseUrl: string, cfg: SarvamRealtimeConfig): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/speech-to-text-realtime/ws`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('language_code', cfg.languageCode);
  url.searchParams.set('model', cfg.model);
  url.searchParams.set('stream_type', cfg.streamType);
  url.searchParams.set('mode', cfg.mode);
  // In `vad` mode the provider owns turn boundaries (ADR-0003): it hears the
  // whole audio diet and emits vad.speech_start / vad.speech_end. In `manual`
  // mode the local detector owns them and the server transcribes only the
  // audio between client-sent speech_start and speech_end.
  url.searchParams.set('endpointing', cfg.endpointing);
  if (cfg.endpointing === 'vad' && cfg.vad) {
    url.searchParams.set('threshold', String(cfg.vad.threshold));
    url.searchParams.set('silence_duration_ms', String(cfg.vad.silenceMs));
    url.searchParams.set('min_speech_duration_ms', String(cfg.vad.minSpeechMs));
  }
  url.searchParams.set('encoding', cfg.encoding);
  url.searchParams.set('sample_rate', String(cfg.sampleRate));
  if (cfg.prompt) url.searchParams.set('prompt', cfg.prompt);
  return url.toString();
}

/**
 * Sarvam realtime STT (`GET {baseUrl}/speech-to-text-realtime/ws`). Partials
 * are ignored; only the per-utterance `transcript.final` matters. Any socket
 * failure rejects `finalize` so the caller can fall back to the REST path.
 */
export class SarvamRealtimeStt implements RealtimeStt {
  private readonly socket: RealtimeSocket;
  private readonly finalTimeoutMs: number;
  private readonly preRollBytes: number;
  private readonly onTrace?: TraceFn;
  private partialHandler?: (partial: PartialTranscript) => void;
  private vadEventHandler?: (event: VadEvent) => void;
  private endpointingMode: RealtimeEndpointing;
  /** A switch requested mid-utterance; applied once the boundary passes. */
  private pendingEndpointing: RealtimeEndpointing | null = null;
  private readonly prompt?: string;
  private readonly promptHash?: string;
  private readonly pendingAudio: Buffer[] = [];
  private readonly outbox: string[] = [];
  private readonly pingTimer: NodeJS.Timeout;
  private ready = false;
  private failed = false;
  private closed = false;
  private speechOpen = false;
  /** A VAD utterance ended and its final has not been read yet. */
  private vadBoundaryOpen = false;
  private pendingBytes = 0;
  private speechStartedAt = 0;
  private partials = 0;
  private nextUtteranceIdx = 0;
  private speechUtteranceIdx: number | null = null;
  /** Timed-out finals remain in flight and must be ignored by their provider index. */
  private readonly timedOutUtterances = new Set<number>();
  /** VAD-mode finals that land before the caller asks to finalize. */
  private readonly earlyFinals = new Map<number, Transcription>();
  private waiting: {
    utteranceIdx: number;
    resolve: (tx: Transcription) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;

  constructor(opts: {
    config: SarvamRealtimeConfig;
    connect?: RealtimeSocketFactory;
    onTrace?: TraceFn;
    onPartial?: (partial: PartialTranscript) => void;
  }) {
    this.finalTimeoutMs = opts.config.finalTimeoutMs ?? DEFAULT_FINAL_TIMEOUT_MS;
    this.preRollBytes = opts.config.preRollBytes ?? DEFAULT_PRE_ROLL_BYTES;
    this.onTrace = opts.onTrace;
    this.partialHandler = opts.onPartial;
    this.endpointingMode = opts.config.endpointing;
    this.prompt = opts.config.prompt;
    this.promptHash = opts.config.prompt
      ? createHash('sha256').update(opts.config.prompt).digest('hex').slice(0, 12)
      : undefined;
    this.socket = (opts.connect ?? defaultSocket)(realtimeUrl(opts.config.baseUrl, opts.config), {
      'api-subscription-key': opts.config.apiKey,
    });
    this.socket.onOpen(() => {
      this.ready = true;
      this.onTrace?.({
        component: 'stt',
        event: 'open',
        model: opts.config.model,
        promptChars: this.prompt?.length,
        promptHash: this.promptHash,
      });
      for (const data of this.outbox.splice(0)) this.socket.send(data);
    });
    this.socket.onMessage((data) => this.receive(data));
    this.socket.onError((err) => this.fail(err));
    this.socket.onClose((code, reason) => {
      this.onTrace?.({ component: 'stt', event: 'close', code, reason });
      if (!this.closed) this.fail(new Error('sarvam-realtime-closed'));
    });
    this.pingTimer = setInterval(() => {
      if (!this.closed && this.ready) this.send({ event: 'ping' });
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
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
    const event = (parsed as { event?: unknown }).event;
    if (event === 'transcript.partial') {
      this.partials += 1;
      const rawIdx = (parsed as { utterance_idx?: unknown }).utterance_idx;
      const text = (parsed as { text?: unknown }).text;
      const language = (parsed as { language?: unknown }).language;
      const partial: PartialTranscript = {
        text: typeof text === 'string' ? text : '',
        ...(typeof rawIdx === 'number' ? { utteranceIdx: rawIdx } : {}),
        ...(typeof language === 'string' ? { language } : {}),
      };
      this.onTrace?.({
        component: 'stt',
        event: 'partial',
        chars: partial.text.length,
        utteranceIdx: partial.utteranceIdx,
        language: partial.language,
      });
      this.partialHandler?.(partial);
      return;
    }
    if (event === 'vad.speech_start') {
      if (!this.speechOpen) this.openUtterance();
      this.onTrace?.({ component: 'stt', event: 'vad-speech-start', utteranceIdx: this.speechUtteranceIdx });
      this.vadEventHandler?.('speech_start');
      return;
    }
    if (event === 'vad.speech_end') {
      this.onTrace?.({ component: 'stt', event: 'vad-speech-end', utteranceIdx: this.speechUtteranceIdx });
      this.vadBoundaryOpen = this.speechOpen;
      this.speechOpen = false;
      this.vadEventHandler?.('speech_end');
      this.adoptPendingEndpointing();
      return;
    }
    if (event === 'config.updated') {
      const applied = (parsed as { applied?: unknown }).applied;
      this.onTrace?.({
        component: 'stt',
        event: 'config-updated',
        applied: Array.isArray(applied) ? applied : undefined,
      });
      return;
    }
    if (event === 'transcript.final') {
      const rawIdx = (parsed as { utterance_idx?: unknown }).utterance_idx;
      const utteranceIdx = typeof rawIdx === 'number' && Number.isInteger(rawIdx) ? rawIdx : undefined;
      if (utteranceIdx !== undefined && this.timedOutUtterances.delete(utteranceIdx)) {
        this.onTrace?.({ component: 'stt', event: 'stale-final', utteranceIdx });
        return;
      }
      const raw = (parsed as { text?: unknown }).text;
      const text = typeof raw === 'string' ? raw : '';
      const waiting = this.waiting;
      if (!waiting) {
        // VAD mode: the provider may deliver the final before the session asks
        // for it. Hold it for the matching finalize call.
        if (this.endpointingMode === 'vad' && utteranceIdx !== undefined) {
          this.traceFinal(utteranceIdx, text);
          if (this.earlyFinals.size >= MAX_EARLY_FINALS) {
            const oldest = this.earlyFinals.keys().next().value as number;
            this.earlyFinals.delete(oldest);
          }
          this.earlyFinals.set(utteranceIdx, { text, noSpeech: text.trim().length === 0 });
        }
        return;
      }
      if (utteranceIdx !== undefined && utteranceIdx !== waiting.utteranceIdx) {
        this.onTrace?.({
          component: 'stt',
          event: 'out-of-order-final',
          utteranceIdx,
          expectedUtteranceIdx: waiting.utteranceIdx,
        });
        return;
      }
      // An unindexed final cannot be distinguished from a late timeout. The
      // current API sends utterance_idx; retain this guard for format drift.
      if (utteranceIdx === undefined && this.timedOutUtterances.size > 0) {
        const staleIdx = this.timedOutUtterances.values().next().value as number;
        this.timedOutUtterances.delete(staleIdx);
        this.onTrace?.({ component: 'stt', event: 'stale-final', utteranceIdx: staleIdx });
        return;
      }
      this.traceFinal(utteranceIdx, text);
      this.waiting = null;
      clearTimeout(waiting.timer);
      waiting.resolve({ text, noSpeech: text.trim().length === 0 });
      return;
    }
    if (event === 'error' && (parsed as { is_fatal?: unknown }).is_fatal === true) {
      const code = (parsed as { code?: unknown }).code;
      this.fail(new Error(`sarvam-realtime-error-${typeof code === 'string' ? code : 'unknown'}`));
    }
  }

  private traceFinal(utteranceIdx: number | undefined, text: string): void {
    const ms = this.speechStartedAt > 0 ? Date.now() - this.speechStartedAt : undefined;
    this.onTrace?.({
      component: 'stt',
      event: 'final',
      ms,
      chars: text.length,
      partials: this.partials,
      noSpeech: text.trim().length === 0,
      utteranceIdx,
    });
  }

  /** `vad` when the provider owns utterance boundaries on this channel. */
  get endpointing(): RealtimeEndpointing {
    return this.endpointingMode;
  }

  /** Subscribe to provider boundary events (VAD mode). */
  onVadEvent(handler: (event: VadEvent) => void): void {
    this.vadEventHandler = handler;
  }

  /**
   * Switch boundary ownership. The provider is told at once — it applies the
   * change at its next utterance boundary — while this adapter keeps its local
   * mode until the current utterance closes, so a stalled provider cannot
   * strand the request.
   */
  setEndpointing(mode: RealtimeEndpointing): void {
    if (this.closed || this.failed || mode === this.endpointingMode) return;
    this.send({ event: 'config.update', endpointing: mode });
    this.onTrace?.({ component: 'stt', event: 'endpointing-update', endpointing: mode });
    if (this.speechOpen) {
      this.pendingEndpointing = mode;
      return;
    }
    this.endpointingMode = mode;
  }

  /** The utterance boundary passed: adopt the mode requested mid-utterance. */
  private adoptPendingEndpointing(): void {
    if (this.pendingEndpointing === null) return;
    this.endpointingMode = this.pendingEndpointing;
    this.pendingEndpointing = null;
  }

  private fail(err: Error): void {
    if (this.failed) return;
    this.failed = true;
    this.onTrace?.({ component: 'stt', event: 'error', detail: err.message });
    const waiting = this.waiting;
    this.waiting = null;
    if (waiting) {
      clearTimeout(waiting.timer);
      waiting.reject(err);
    }
  }

  pushAudio(mulaw: Buffer): void {
    if (this.closed || this.failed || mulaw.length === 0) return;
    // VAD mode streams the whole diet (silence included) so the provider's
    // own VAD can hear it; manual mode streams only once speech is open.
    if (this.endpointingMode === 'vad' || this.speechOpen) {
      this.send({ event: 'audio_input', audio: mulaw.toString('base64') });
      return;
    }
    this.pendingAudio.push(mulaw);
    this.pendingBytes += mulaw.length;
    // Keep only the recent pre-roll: a long silence before speech must not be
    // billed as audio or pushed into the utterance.
    while (this.pendingBytes > this.preRollBytes && this.pendingAudio.length > 1) {
      this.pendingBytes -= this.pendingAudio.shift()!.length;
    }
  }

  /** Claim the next utterance index and open one; shared by both modes. */
  private openUtterance(): void {
    this.speechOpen = true;
    this.vadBoundaryOpen = false;
    this.speechUtteranceIdx = this.nextUtteranceIdx;
    this.nextUtteranceIdx += 1;
    this.speechStartedAt = Date.now();
    this.partials = 0;
  }

  speechStart(): void {
    if (this.closed || this.failed || this.speechOpen) return;
    // VAD mode: the provider announces the boundary itself; a client
    // speech_start would open a second, conflicting utterance.
    if (this.endpointingMode === 'vad') return;
    this.openUtterance();
    const bufferedBytes = this.pendingBytes;
    this.send({ event: 'speech_start' });
    for (const chunk of this.pendingAudio.splice(0)) {
      this.send({ event: 'audio_input', audio: chunk.toString('base64') });
    }
    this.pendingBytes = 0;
    this.onTrace?.({ component: 'stt', event: 'speech-start', bufferedBytes });
  }

  /** Boundary-gated context update; the server applies it at the next utterance. */
  reconfigure(context: TranscriptionContext): void {
    if (this.closed || this.failed) return;
    const update: Record<string, unknown> = { event: 'config.update' };
    if (context.prompt !== undefined) update['prompt'] = context.prompt;
    if (context.languageCode !== undefined) update['language_code'] = context.languageCode;
    this.send(update);
    this.onTrace?.({
      component: 'stt',
      event: 'config-update',
      promptChars: context.prompt?.length,
      language: context.languageCode,
    });
  }

  /** Subscribe (or replace) the partial handler used for read-only speculation. */
  onPartial(handler: (partial: PartialTranscript) => void): void {
    this.partialHandler = handler;
  }

  finalize(): Promise<Transcription> {
    // Manual mode streams between speech_start and speech_end; a VAD
    // utterance is open from its boundary until its final is read.
    if (this.closed || this.failed || this.speechUtteranceIdx === null || (!this.speechOpen && !this.vadBoundaryOpen)) {
      return Promise.reject(new Error('sarvam-realtime-not-streaming'));
    }
    if (this.waiting) return Promise.reject(new Error('sarvam-realtime-finalize-in-flight'));
    const utteranceIdx = this.speechUtteranceIdx;
    if (this.endpointingMode === 'manual' && this.speechOpen) this.send({ event: 'speech_end' });
    this.speechOpen = false;
    this.vadBoundaryOpen = false;
    this.speechUtteranceIdx = null;
    const early = this.earlyFinals.get(utteranceIdx);
    if (early) {
      this.earlyFinals.delete(utteranceIdx);
      this.adoptPendingEndpointing();
      return Promise.resolve(early);
    }
    return new Promise<Transcription>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        this.timedOutUtterances.add(utteranceIdx);
        this.onTrace?.({ component: 'stt', event: 'final-timeout', ms: this.finalTimeoutMs, utteranceIdx });
        reject(new Error('sarvam-realtime-final-timeout'));
      }, this.finalTimeoutMs);
      this.waiting = {
        utteranceIdx,
        resolve: (tx) => {
          this.adoptPendingEndpointing();
          resolve(tx);
        },
        reject,
        timer,
      };
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pingTimer);
    const waiting = this.waiting;
    this.waiting = null;
    if (waiting) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error('sarvam-realtime-closed'));
    }
    try {
      this.socket.send(JSON.stringify({ event: 'end' }));
      this.socket.close();
    } catch {
      // Socket already gone; nothing left to release.
    }
  }
}
