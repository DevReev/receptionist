import {
  availabilityPlaceholder,
  BOOKING_FAILURE_LINE,
  FAILURE_LINE,
  greetingFor,
  goodbyeFor,
  HOLD_ASSISTANT_LINE,
  NO_RESPONSE_LINE,
  REPROMPT_LINE,
  type Assistant,
  type AssistantEvent,
  type BookingOutcome,
  type ProposedSlot,
  type Transcriber,
  type Transcription,
} from './app.ts';
import { encodeWav } from './audio.ts';
import type { CallStore } from './calls.ts';
import type { ClinicGuide } from './clinic.ts';
import {
  DialogueReducer,
  emptyDialogueState,
  isAvailabilityIntent,
  parseAvailabilityBlock,
  spokenDate,
  spokenTime,
  type DialogueDecision,
  type DialogueState,
  type SlotOption,
} from './dialogue.ts';
import { type BargeInEvent, type EndpointPolicy, type Utterance, type Vad } from './endpoint.ts';
import type { FixedAudioCache } from './fixedAudio.ts';
import type { RealtimeStt } from './sarvamRealtime.ts';
import type { PlaybackResult } from './transport.ts';
import type { StreamIdentity } from './stream.ts';
import type { TraceFn } from './trace.ts';
import { TurnTaking, type TurnDetection, type UtteranceSpeechStats } from './turnTaking.ts';
import { bufferedSpeech, type SpeechResponse, type Tts } from './tts.ts';
import type { FailureEvent, TurnEvent } from './app.ts';

export interface LiveProposeBookingArgs {
  callSid: string;
  turn: number;
  excerpt: string;
  slot: ProposedSlot;
}

export type LivePhase =
  | 'GREETING'
  | 'LISTENING'
  | 'FINALIZING'
  | 'PLANNING'
  | 'SPEAKING'
  | 'INTERRUPTING'
  | 'BOOKING'
  | 'CLOSED';

export type { BargeInEvent } from './endpoint.ts';

export interface LiveCallOptions {
  identity: StreamIdentity;
  sendAudio: (audio: Buffer) => void;
  vad: Vad;
  policy: EndpointPolicy;
  transcriber: Transcriber;
  /**
   * Optional live transcription channel for this call. When present, audio is
   * streamed as the Caller speaks and each utterance reads its final from here;
   * a failed session falls back to `transcriber` for that utterance.
   */
  realtime?: RealtimeStt;
  /** Selective independent second decode for critical fields; never every Turn. */
  secondOpinion?: Transcriber;
  tts: Tts;
  guide: ClinicGuide;
  /** Fresh guide per open when hot-reload matters; falls back to `guide`. */
  loadGuide?: () => Promise<ClinicGuide>;
  /** Assistant that drafts the grounded reply; absent = transcribe-only (tickets 09/10). */
  assistant?: Assistant;
  /** Live Availability block; re-resolved every Turn so Slots stay fresh. */
  availability?: string | (() => string | Promise<string>);
  /** Speak a holding line when a Turn phase runs longer than this. <=0 disables holds. */
  holdAfterMs?: number;
  /** Silence after the Receptionist stops speaking before it asks again. <=0 disables. */
  noResponseMs?: number;
  /** Overall deadline for the Availability read. <=0 waits forever. */
  availabilityTimeoutMs?: number;
  /** Single-attempt booking proposal, same seam as the legacy loop. */
  onProposeBooking?: (args: LiveProposeBookingArgs) => Promise<BookingOutcome>;
  /** Stop audible speech on sustained Caller speech. Default off until live validation. */
  bargeIn?: boolean;
  /** Sustained speech threshold before barge-in fires. */
  interruptionMs?: number;
  /**
   * `sarvam` (default): the provider owns Turn boundaries when the realtime
   * channel is in VAD mode. `hybrid`: the local detector owns them. Without a
   * boundary-capable realtime channel the local detector is used either way.
   */
  turnDetection?: TurnDetection;
  /** Whole-Turn deadline for the LLM response. <=0 disables. */
  turnDeadlineMs?: number;
  /** Shared fixed-phrase audio cache; hits skip the provider. */
  fixedCache?: FixedAudioCache;
  /** Injectable reducer for deterministic tests. */
  dialogue?: DialogueReducer;
  calls: CallStore;
  logTurn?: (event: TurnEvent) => void;
  logFailure?: (event: FailureEvent) => void;
  onUtteranceLog?: (entry: { callSid: string; durationMs: number; bytes: number }) => void;
  /** Debug-only (env-gated): receives each utterance WAV before transcription. */
  onUtteranceAudio?: (entry: { callSid: string; turn: number; wav: Buffer }) => void;
  /** Debug-only (env-gated): receives each transcribed utterance for fixture capture. */
  onUtteranceTranscribed?: (entry: { callSid: string; turn: number; text: string; wav: Buffer }) => void;
  /** Session lifecycle + VAD diagnostics; the console handoff channel. */
  logSession?: (event: Record<string, unknown>) => void;
  /** Component-level trace for STT/TTS/VAD/stream internals, scoped by the caller. */
  trace?: TraceFn;
  /** Playback-completion signal the Endpointing timer keys off. */
  onPlaybackComplete?: (text: string) => void;
  /** Ordered barrier: resolves after all audio queued before it played or was cleared. */
  finishPlayback?: (generation?: number) => Promise<PlaybackResult>;
  /** Legacy void promise; treated as an immediate played mark when it resolves. */
  waitForPlayback?: () => Promise<void>;
  /** Drops queued audio immediately; required for barge-in. */
  clearPlayback?: (reason: string) => void;
  onClose?: (reason: string) => void;
}

/**
 * Split buffered reply text into complete spoken sentences. A sentence ends
 * at `.`/`!`/`?` (plus trailing closers) followed by whitespace or the end
 * of the buffer. The remainder stays buffered until more tokens arrive.
 */
export function extractCompleteSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;
    let end = i + 1;
    while (end < buffer.length && (buffer[end] === '"' || buffer[end] === "'" || buffer[end] === ')' || buffer[end] === ']')) {
      end += 1;
    }
    if (end < buffer.length && !/\s/.test(buffer[end]!)) continue;
    const sentence = buffer.slice(start, end).trim();
    if (sentence) sentences.push(sentence);
    let next = end;
    while (next < buffer.length && /\s/.test(buffer[next]!)) next += 1;
    start = next;
    i = next - 1;
  }
  return { sentences, rest: buffer.slice(start) };
}

/** The last question sentence in spoken text, for asking it again on silence. */
function lastQuestionIn(text: string): string | null {
  const { sentences } = extractCompleteSentences(text);
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const sentence = sentences[i]!;
    if (sentence.endsWith('?')) return sentence;
  }
  return null;
}

const ABBREVIATIONS = ['mr.', 'mrs.', 'ms.', 'dr.', 'st.', 'vs.', 'rs.', 'no.', 'e.g.', 'i.e.'];

/**
 * Voice chunker: emits speakable phrases early without splitting abbreviations,
 * dates, times, phone numbers, or currency. All phrases feed one TTS response.
 */
export class VoiceChunker {
  private buffer = '';
  private readonly minChars: number;

  constructor(minChars = 40) {
    this.minChars = minChars;
  }

  push(token: string): string[] {
    this.buffer += token;
    const phrases: string[] = [];
    for (;;) {
      const cut = this.findCut();
      if (cut === null) break;
      const phrase = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut);
      if (phrase) phrases.push(phrase);
    }
    return phrases;
  }

  flush(): string | null {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest.length > 0 ? rest : null;
  }

  private findCut(): number | null {
    const text = this.buffer;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (ch !== '.' && ch !== '!' && ch !== '?') continue;
      const next = text[i + 1];
      if (next !== undefined && !/\s/.test(next)) continue;
      const prefix = text.slice(0, i + 1).toLowerCase();
      const word = /([a-z.]+)$/.exec(prefix)?.[1] ?? '';
      if (ch === '.' && ABBREVIATIONS.includes(word)) continue;
      return i + 1;
    }
    if (text.length < this.minChars) return null;
    const lastSpace = text.lastIndexOf(' ');
    if (lastSpace >= this.minChars) return lastSpace + 1;
    return null;
  }
}

function ttsDetail(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.startsWith('tts-error:') ? msg : `tts-error: ${msg}`;
}

function isAbortError(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (err instanceof Error && err.name === 'AbortError');
}

/** No-provider response used for fixed-cache hits and terminal states. */
function silentResponse(generation: number): SpeechResponse {
  return {
    generation,
    pushText: () => {},
    finishText: () => {},
    audio: async function* empty(): AsyncGenerator<Buffer> {},
    cancel: () => {},
  };
}

/**
 * How long the open-of-call Availability prefetch may serve later Turns.
 * Past this, a Turn re-reads so offered Slots stay fresh; the booking write
 * always re-checks live Availability before saving.
 */
const WARM_AVAILABILITY_MS = 120_000;
const DEFAULT_TURN_DEADLINE_MS = 6000;

interface ActiveSpeech {
  generation: number;
  text: string;
  kind: 'response' | 'readback';
  abort: AbortController;
  response: SpeechResponse;
  cancelled: boolean;
}

/**
 * One call's live loop: endpointed Caller Turns, a deterministic dialogue
 * controller, grounded LLM wording, incremental TTS, and paced response-tail
 * playback marks. Barge-in cancels a response generation without ever
 * cancelling a Booking write that has begun.
 */
export class LiveCallSession {
  private readonly identity: StreamIdentity;
  private readonly sendAudio: (audio: Buffer) => void;
  private readonly turnTaking: TurnTaking;
  private readonly transcriber: Transcriber;
  private readonly realtime: RealtimeStt | undefined;
  private readonly secondOpinion: Transcriber | undefined;
  private readonly tts: Tts;
  private guide: ClinicGuide;
  private readonly loadGuide: (() => Promise<ClinicGuide>) | undefined;
  private readonly assistant: Assistant | undefined;
  private readonly availability: string | (() => string | Promise<string>) | undefined;
  private readonly holdAfterMs: number;
  private readonly noResponseMs: number;
  private readonly availabilityTimeoutMs: number;
  private readonly bargeIn: boolean;
  /** True when provider `vad.*` events own Turn boundaries on this call. */
  private readonly providerBoundaries: boolean;
  private readonly turnDeadlineMs: number;
  private readonly fixedCache: FixedAudioCache | undefined;
  private readonly reducer: DialogueReducer;
  private readonly onProposeBooking:
    | ((args: LiveProposeBookingArgs) => Promise<BookingOutcome>)
    | undefined;
  private readonly calls: CallStore;
  private readonly logTurn?: (event: TurnEvent) => void;
  private readonly logFailure?: (event: FailureEvent) => void;
  private readonly onUtteranceLog?: (entry: { callSid: string; durationMs: number; bytes: number }) => void;
  private readonly onUtteranceAudio?: (entry: { callSid: string; turn: number; wav: Buffer }) => void;
  private readonly onUtteranceTranscribed?: (entry: { callSid: string; turn: number; text: string; wav: Buffer }) => void;
  private readonly logSession?: (event: Record<string, unknown>) => void;
  private readonly trace?: TraceFn;
  private readonly onPlaybackComplete?: (text: string) => void;
  private readonly finishPlaybackFn?: (generation?: number) => Promise<PlaybackResult>;
  private readonly clearPlaybackFn?: (reason: string) => void;
  private readonly onCloseCb?: (reason: string) => void;
  private phase: LivePhase = 'GREETING';
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
  private greeted = false;
  /** Serializes all outgoing speech so holds and replies never overlap. */
  private speechTail: Promise<void> = Promise.resolve();
  /** Monotonic response generation; every spoken response owns one. */
  private generation = 0;
  /** Responses at or below this generation were interrupted and must not play. */
  private cancelledThrough = 0;
  private activeSpeech: ActiveSpeech | null = null;
  /** One Availability read per Turn, however many times the assistant asks. */
  private availabilityForTurn: { turn: number; value: Promise<{ block: string; slots: SlotOption[] }> } | null = null;
  /** Availability read started when the session opened; early Turns reuse it. */
  private warmAvailability: {
    startedAt: number;
    value: Promise<{ block: string; slots: SlotOption[] }>;
    block: string | null;
    slots: SlotOption[];
  } | null = null;
  private dialogue: DialogueState = emptyDialogueState();
  private partialWarmStarted = false;
  private scoreStats = { n: 0, max: 0, latched: false };
  /** Silence watch: armed while listening, disarmed by Caller speech. */
  private noResponseTimer: NodeJS.Timeout | null = null;
  private noResponsePrompts = 0;
  /** Last question spoken, revisited when the Caller goes quiet. */
  private lastQuestion: string | null = null;
  private readonly scoreTimer: NodeJS.Timeout;
  /**
   * Turn opened by handleUtterance but not yet settled by a Turn log.
   * close() drains this as a partial Turn so a hangup never goes unlogged.
   */
  private activeTurn: { turn: number; excerpt: string; replySoFar: string } | null = null;

  constructor(opts: LiveCallOptions) {
    this.identity = opts.identity;
    this.sendAudio = opts.sendAudio;
    this.transcriber = opts.transcriber;
    this.realtime = opts.realtime;
    this.secondOpinion = opts.secondOpinion;
    this.tts = opts.tts;
    this.guide = opts.guide;
    this.loadGuide = opts.loadGuide;
    this.assistant = opts.assistant;
    this.availability = opts.availability;
    this.holdAfterMs = opts.holdAfterMs ?? 3000;
    this.noResponseMs = opts.noResponseMs ?? 0;
    this.availabilityTimeoutMs = opts.availabilityTimeoutMs ?? 0;
    this.bargeIn = opts.bargeIn ?? false;
    this.providerBoundaries =
      (opts.turnDetection ?? 'sarvam') === 'sarvam' && opts.realtime?.endpointing === 'vad';
    this.turnDeadlineMs = opts.turnDeadlineMs ?? DEFAULT_TURN_DEADLINE_MS;
    this.fixedCache = opts.fixedCache;
    this.reducer = opts.dialogue ?? new DialogueReducer();
    this.onProposeBooking = opts.onProposeBooking;
    this.calls = opts.calls;
    this.logTurn = opts.logTurn;
    this.logFailure = opts.logFailure;
    this.onUtteranceLog = opts.onUtteranceLog;
    this.onUtteranceAudio = opts.onUtteranceAudio;
    this.onUtteranceTranscribed = opts.onUtteranceTranscribed;
    this.logSession = opts.logSession;
    this.trace = opts.trace;
    this.onPlaybackComplete = opts.onPlaybackComplete;
    this.clearPlaybackFn = opts.clearPlayback;
    this.onCloseCb = opts.onClose;
    this.finishPlaybackFn =
      opts.finishPlayback ??
      (opts.waitForPlayback
        ? () => opts.waitForPlayback!().then((): PlaybackResult => ({ outcome: 'played', mark: '' }))
        : undefined);
    this.turnTaking = new TurnTaking({
      vad: opts.vad,
      policy: opts.policy,
      bargeInMs: opts.interruptionMs,
      detection: this.providerBoundaries ? 'sarvam' : 'hybrid',
      observer: {
        onUtterance: (utterance, stats) => {
          this.pending = this.pending.then(() => this.handleUtterance(utterance, stats)).catch(() => {});
        },
        onBargeIn: (event) => this.handleBargeIn(event),
        onSpeechStart: () => {
          this.cancelNoResponse();
          // In provider VAD mode the boundary came from the channel itself.
          if (!this.providerBoundaries) this.realtime?.speechStart();
        },
        onUpstreamFrame: (frame) => this.realtime?.pushAudio(frame),
        onScore: (score, latched) => {
          this.scoreStats.n += 1;
          if (score > this.scoreStats.max) this.scoreStats.max = score;
          if (latched) this.scoreStats.latched = true;
        },
      },
    });
    this.scoreTimer = setInterval(() => {
      if (this.closed || this.scoreStats.n === 0) return;
      this.logSession?.({
        callSid: this.identity.callSid,
        kind: 'vad',
        frames: this.scoreStats.n,
        maxScore: Number(this.scoreStats.max.toFixed(3)),
        latched: this.scoreStats.latched,
      });
      this.scoreStats = { n: 0, max: 0, latched: false };
    }, 2000);
    this.scoreTimer.unref?.();
    // A stable booking partial may start a read-only availability prefetch
    // before the Caller finishes; it can never write a Booking.
    opts.realtime?.onPartial?.((partial) => this.handlePartial(partial.text));
    // Provider VAD mode: the provider's boundary opens and closes the
    // utterance; the Turn's final is read from the same channel.
    if (this.providerBoundaries) {
      opts.realtime?.onVadEvent?.((event) => {
        if (this.closed) return;
        if (event === 'speech_start') this.turnTaking.providerSpeechStart();
        else this.turnTaking.providerSpeechEnd();
      });
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get currentPhase(): LivePhase {
    return this.phase;
  }

  get state(): DialogueState {
    return this.dialogue;
  }

  /** Session open: greet through the session's own TTS path (one voice). */
  async open(): Promise<void> {
    if (this.closed || this.greeted) return;
    this.greeted = true;
    this.setPhase('GREETING');
    this.logSession?.({ callSid: this.identity.callSid, kind: 'session', event: 'open' });
    this.prefetchAvailability();
    if (this.loadGuide) {
      try {
        this.guide = await this.loadGuide();
      } catch {
        // Greet with the injected guide rather than leaving the Caller on silence.
      }
    }
    await this.speakFixed(greetingFor(this.guide));
  }

  receiveAudio(mulaw: Buffer): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.turnTaking.receiveAudio(mulaw);
  }

  /** Test seam: wait for queued utterance handlers. */
  async flush(): Promise<void> {
    await this.pending;
  }

  /** Text in, audio out, plus the playback-completion the endpoint timer keys off. */
  async speak(text: string): Promise<void> {
    await this.enqueueResponse(text, { kind: 'response', fixed: false, commit: false });
  }

  /** Fixed-phrase speech: cache hits never touch the provider. */
  async speakFixed(text: string): Promise<void> {
    await this.enqueueResponse(text, { kind: 'response', fixed: true, commit: false });
  }

  /** Resume listening and arm the silence watch for the next Caller turn. */
  private beginListening(): void {
    this.setPhase('LISTENING');
    this.turnTaking.startListening();
    this.scheduleNoResponse();
  }

  /**
   * The Caller may ponder or walk away after a question; when the listening
   * window passes in silence, ask again — repeating the last question when
   * there was one. Two asks, then a polite goodbye and close.
   */
  private scheduleNoResponse(): void {
    if (this.closed || this.noResponseMs <= 0) return;
    this.cancelNoResponse();
    const timer = setTimeout(() => {
      this.noResponseTimer = null;
      void this.handleNoResponse();
    }, this.noResponseMs);
    timer.unref?.();
    this.noResponseTimer = timer;
  }

  private cancelNoResponse(): void {
    if (this.noResponseTimer === null) return;
    clearTimeout(this.noResponseTimer);
    this.noResponseTimer = null;
  }

  private async handleNoResponse(): Promise<void> {
    if (this.closed || !this.turnTaking.isListening || this.activeTurn) return;
    const state = this.calls.get(this.identity.callSid);
    this.noResponsePrompts += 1;
    if (this.noResponsePrompts > 2) {
      this.logFailure?.({
        callSid: this.identity.callSid,
        turn: state.turn,
        reason: 'low-confidence',
        excerpt: '',
        detail: 'no-response',
      });
      const goodbye = goodbyeFor(this.guide);
      this.logTurn?.({
        callSid: this.identity.callSid,
        turn: state.turn,
        excerpt: '',
        reply: goodbye,
        endCall: true,
        miss: true,
      });
      try {
        await this.speakFixed(goodbye);
      } catch {
        // TTS failed too; the failure log above is the handoff channel.
      }
      this.close('goodbye');
      return;
    }
    const line = this.lastQuestion ? `${NO_RESPONSE_LINE} ${this.lastQuestion}` : NO_RESPONSE_LINE;
    this.logTurn?.({
      callSid: this.identity.callSid,
      turn: state.turn,
      excerpt: '',
      reply: line,
      endCall: false,
      miss: true,
    });
    try {
      await this.speakFixed(line);
    } catch (err) {
      const ttsCause = err instanceof Error ? `tts-error: ${err.message}` : `tts-error: ${String(err)}`;
      this.logFailure?.({ callSid: this.identity.callSid, turn: state.turn, reason: 'low-confidence', excerpt: '', detail: ttsCause });
      this.close('failure');
    }
  }

  private setPhase(phase: LivePhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.trace?.({ component: 'call', event: 'phase', phase });
  }

  /** Queue a whole logical response behind whatever is already playing. */
  private enqueueResponse(
    text: string | null,
    opts: { kind: 'response' | 'readback'; fixed: boolean; commit: boolean; generation?: number },
  ): Promise<void> {
    if (this.closed) return Promise.resolve();
    // Suspend listening immediately: the response may be queued behind another
    // one, and inbound audio must never endpoint into a new Turn meanwhile.
    if (this.activeSpeech === null && this.phase !== 'SPEAKING') this.prepareSpeaking();
    const generation = opts.generation ?? this.nextGeneration();
    const run = this.speechTail.then(() => this.runResponse(generation, text, opts));
    this.speechTail = run.catch(() => {});
    return run;
  }

  private nextGeneration(): number {
    this.generation += 1;
    return this.generation;
  }

  private async runResponse(
    generation: number,
    text: string | null,
    opts: { kind: 'response' | 'readback'; fixed: boolean; commit: boolean },
  ): Promise<void> {
    if (this.closed || generation <= this.cancelledThrough) return;
    const question = text ? lastQuestionIn(text) : null;
    if (question) this.lastQuestion = question;
    const fixedBytes = opts.fixed && text ? this.fixedCache?.get(text) : undefined;
    const speech: ActiveSpeech = {
      generation,
      text: text ?? '',
      kind: opts.kind,
      abort: new AbortController(),
      response: silentResponse(generation),
      cancelled: false,
    };
    this.setPhase('SPEAKING');
    this.prepareSpeaking();
    this.activeSpeech = speech;
    this.logPhase('tts', 'start', { generation, chars: text?.length ?? 0 });
    try {
      if (fixedBytes) {
        // Cache hits never touch the provider, but still pass through the
        // paced transport queue and the response-tail mark barrier.
        this.sendAudio(fixedBytes);
      } else if (text !== null) {
        const response = this.createSpeechResponse(generation);
        speech.response = response;
        const collect = opts.fixed && this.fixedCache !== undefined;
        const chunks: Buffer[] = [];
        const audioDrain = (async () => {
          try {
            for await (const chunk of response.audio()) {
              if (this.closed || speech.cancelled || generation !== this.generation) return;
              this.sendAudio(chunk);
              if (collect) chunks.push(chunk);
            }
          } catch (err) {
            if (speech.cancelled || generation !== this.generation) return;
            throw err;
          }
        })();
        response.pushText(text);
        response.finishText();
        await audioDrain;
        if (collect && chunks.length > 0) this.fixedCache?.set(text, Buffer.concat(chunks));
      }
      if (speech.cancelled || this.closed || generation !== this.generation) return;
      const result = await this.finishPlayback(generation);
      if (result.outcome === 'cleared') {
        this.onCleared(speech, result.reason);
        return;
      }
      this.trace?.({ component: 'twilio', event: 'playback-complete', generation });
      this.onPlaybackComplete?.(speech.text);
      this.logPhase('tts', 'done', { generation, chars: speech.text.length });
      if (opts.commit && speech.text) {
        this.calls.pushHistory(this.identity.callSid, { role: 'receptionist', text: speech.text });
      }
      if (this.activeTurn && speech.text) this.activeTurn.replySoFar = speech.text;
      if (opts.kind === 'readback') {
        this.dialogue = this.reducer.markReadbackPlayed(this.dialogue, generation);
      }
    } finally {
      this.activeSpeech = null;
      if (!this.closed && this.phase === 'SPEAKING') this.beginListening();
    }
  }

  private createSpeechResponse(generation: number): SpeechResponse {
    if (this.tts.begin) return this.tts.begin({ generation });
    return bufferedSpeech(this.tts, {
      generation,
      onFallback: (text, detail) => this.logPhase('tts', 'fallback', { chars: text.length, detail }),
    });
  }

  private finishPlayback(generation: number): Promise<PlaybackResult> {
    if (!this.finishPlaybackFn) return Promise.resolve({ outcome: 'played', mark: '' });
    return this.finishPlaybackFn(generation);
  }

  private onCleared(speech: ActiveSpeech, reason: string): void {
    this.trace?.({ component: 'call', event: 'playback-cleared', reason, generation: speech.generation });
    if (speech.kind === 'readback') {
      this.dialogue = this.reducer.clearReadback(this.dialogue);
    }
  }

  /** While speaking: mute, or watch for Barge-in candidates when barge-in is on. */
  private prepareSpeaking(): void {
    this.turnTaking.startSpeaking({ watchForBargeIn: this.bargeIn });
    this.cancelNoResponse();
  }

  /** Sustained Caller speech during a response: clear audio and open a new Turn. */
  private handleBargeIn(event: BargeInEvent): void {
    if (this.closed || !this.bargeIn || this.phase !== 'SPEAKING') return;
    const speech = this.activeSpeech;
    this.setPhase('INTERRUPTING');
    this.trace?.({
      component: 'call',
      event: 'barge-in',
      generation: speech?.generation,
      candidateMs: event.durationMs,
    });
    this.clearPlaybackFn?.('caller-barge-in');
    if (speech) {
      speech.cancelled = true;
      speech.abort.abort();
      speech.response.cancel('caller-barge-in');
      this.cancelledThrough = speech.generation;
      if (speech.kind === 'readback') this.dialogue = this.reducer.clearReadback(this.dialogue);
    }
    this.activeSpeech = null;
    // The retained candidate becomes the start of the next utterance: the
    // first word is preserved instead of being dropped with the response.
    this.turnTaking.acceptBargeIn(event);
    this.setPhase('LISTENING');
    this.scheduleNoResponse();
  }

  /** Read-only speculation from a stable partial; writes stay forbidden. */
  private handlePartial(text: string): void {
    if (this.closed || this.partialWarmStarted || this.availabilityForTurn) return;
    if (!isAvailabilityIntent(text)) return;
    this.partialWarmStarted = true;
    this.logPhase('availability', 'speculative-start', { chars: text.length });
    this.prefetchAvailability();
  }

  private async resolveAvailability(): Promise<{ block: string; slots: SlotOption[] }> {    const pending = Promise.resolve()
      .then(() =>
        typeof this.availability === 'function' ? this.availability() : (this.availability ?? availabilityPlaceholder()),
      )
      .then((block) => ({ block, slots: parseAvailabilityBlock(block) }));
    const timeoutMs = this.availabilityTimeoutMs;
    if (timeoutMs <= 0) return pending;
    let timer: NodeJS.Timeout | undefined;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`availability-timeout after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([pending, expiry]);
    } finally {
      if (timer) clearTimeout(timer);
      pending.catch(() => {});
    }
  }

  /**
   * Start the availability read while the greeting plays so the Caller's
   * first booking Turn does not wait on a Picktime scrape. Errors clear the
   * warm read and fall through to the normal lazy path on a later Turn.
   */
  private prefetchAvailability(): void {
    if (this.closed || this.warmAvailability || !this.availability) return;
    const started = Date.now();
    this.logPhase('availability', 'start', { turn: 0, prefetch: true });
    const warm: {
      startedAt: number;
      value: Promise<{ block: string; slots: SlotOption[] }>;
      block: string | null;
      slots: SlotOption[];
    } = { startedAt: started, value: Promise.resolve({ block: '', slots: [] }), block: null, slots: [] };
    warm.value = this.resolveAvailability()
      .then(({ block, slots }) => {
        warm.block = block;
        warm.slots = slots;
        this.logPhase('availability', 'done', {
          turn: 0,
          prefetch: true,
          ms: Date.now() - started,
          chars: block.length,
          slots: slots.length,
          none: /(^|\n)- none:/.test(block),
        });
        return { block, slots };
      })
      .catch((err: unknown) => {
        this.logPhase('availability', 'error', {
          turn: 0,
          prefetch: true,
          ms: Date.now() - started,
          detail: err instanceof Error ? err.message : String(err),
        });
        this.warmAvailability = null;
        throw err;
      });
    warm.value.catch(() => {});
    this.warmAvailability = warm;
  }

  /**
   * Controller-owned Availability read: reuses the open-of-call prefetch
   * while it is fresh, otherwise reads live. One read per Turn.
   */
  private loadAvailability(turn: number): Promise<{ block: string; slots: SlotOption[] }> {
    if (this.availabilityForTurn?.turn === turn) return this.availabilityForTurn.value;
    const warm = this.warmAvailability;
    const useWarm = warm !== null && Date.now() - warm.startedAt < WARM_AVAILABILITY_MS;
    const started = Date.now();
    if (!useWarm) this.logPhase('availability', 'start', { turn });
    const value = (useWarm ? warm.value : this.resolveAvailability())
      .then((result) => {
        if (!useWarm) {
          this.logPhase('availability', 'done', {
            turn,
            ms: Date.now() - started,
            chars: result.block.length,
            slots: result.slots.length,
            none: /(^|\n)- none:/.test(result.block),
          });
        }
        return result;
      })
      .catch((err: unknown) => {
        if (!useWarm) {
          this.logPhase('availability', 'error', {
            turn,
            ms: Date.now() - started,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
        throw err;
      });
    this.availabilityForTurn = { turn, value };
    return value;
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.setPhase('CLOSED');
    this.cancelNoResponse();
    clearInterval(this.scoreTimer);
    this.logSession?.({ callSid: this.identity.callSid, kind: 'session', event: 'close', reason });
    this.activeSpeech?.abort.abort();
    this.activeSpeech?.response.cancel('call-closed');
    this.activeSpeech = null;
    this.realtime?.close();
    this.tts.close?.();
    this.turnTaking.close();
    if (this.activeTurn) {
      const partial = this.activeTurn;
      this.activeTurn = null;
      this.logTurn?.({
        callSid: this.identity.callSid,
        turn: partial.turn,
        excerpt: partial.excerpt,
        reply: partial.replySoFar,
        endCall: true,
        miss: false,
      });
    }
    this.onCloseCb?.(reason);
  }

  private async handleUtterance(utterance: Utterance, stats: UtteranceSpeechStats): Promise<void> {
    if (this.closed) return;
    this.cancelNoResponse();
    this.noResponsePrompts = 0;
    const state = this.calls.get(this.identity.callSid);
    state.turn += 1;
    const turn = state.turn;
    this.setPhase('FINALIZING');
    this.onUtteranceLog?.({
      callSid: this.identity.callSid,
      durationMs: utterance.durationMs,
      bytes: utterance.audio.length,
    });
    this.trace?.({
      component: 'vad',
      event: 'endpoint',
      turn,
      source: this.providerBoundaries ? 'provider' : 'local',
      speechMs: utterance.durationMs,
      frames: stats.frames,
      maxScore: stats.maxScore,
      meanScore: stats.meanScore,
    });
    this.activeTurn = { turn, excerpt: '', replySoFar: '' };
    let text = '';
    const transcribeStarted = Date.now();
    this.logPhase('transcribe', 'start', { turn });
    let wav: Buffer | null = null;
    try {
      wav = encodeWav(utterance.audio);
      this.onUtteranceAudio?.({ callSid: this.identity.callSid, turn, wav });
      let tx: Transcription | null = null;
      let source = 'rest';
      if (this.realtime) {
        try {
          tx = await this.realtime.finalize();
          source = 'realtime';
        } catch (err) {
          this.logPhase('transcribe', 'fallback', {
            turn,
            ms: Date.now() - transcribeStarted,
            detail: err instanceof Error ? err.message : String(err),
          });
          if (this.closed) return;
        }
      }
      // An empty realtime final may re-decode through REST before counting as no speech.
      if (!tx || !tx.text.trim()) {
        const rest = await this.transcriber.transcribe(wav, 'audio/wav');
        if (rest.text.trim() || !tx) {
          tx = rest;
          source = source === 'realtime' ? 'realtime-empty-rest' : 'rest';
        }
      }
      if (this.closed) return;
      this.logPhase('transcribe', 'done', {
        turn,
        ms: Date.now() - transcribeStarted,
        chars: tx.text.length,
        noSpeech: tx.noSpeech,
        source,
      });
      if (!tx.text.trim() || tx.noSpeech) {
        await this.miss(tx.text, turn, undefined);
        return;
      }
      text = tx.text;
      if (wav) this.onUtteranceTranscribed?.({ callSid: this.identity.callSid, turn, text: tx.text, wav });
    } catch (err) {
      if (this.closed) return;
      const detail = err instanceof Error ? `transcribe-error: ${err.message}` : `transcribe-error: ${String(err)}`;
      this.logPhase('transcribe', 'error', { turn, ms: Date.now() - transcribeStarted, detail });
      await this.miss(text, turn, detail);
      return;
    }
    state.misses = 0;
    this.activeTurn.excerpt = text;
    this.calls.pushHistory(this.identity.callSid, { role: 'caller', text });
    await this.reduceAndAnswer(text, turn, wav);
  }

  /**
   * Controller-first Turn: reduce the transcript into a dialogue decision and
   * execute it. Only `continue`/`availability` reach the LLM; reads, field
   * questions, readbacks, writes, and goodbyes are deterministic.
   */
  private async reduceAndAnswer(excerpt: string, turn: number, wav: Buffer | null): Promise<void> {
    this.setPhase('PLANNING');
    const before = this.dialogue;
    let availabilityBlock: string | undefined;
    let { state, decision } = this.reducer.reduce({
      transcript: excerpt,
      state: this.dialogue,
      callerPhone: this.identity.callerPhone,
    });
    this.dialogue = state;
    const patientChanged =
      state.patient.name !== before.patient.name || state.patient.phone !== before.patient.phone;
    this.trace?.({ component: 'dialogue', event: 'reduced', turn, phase: state.phase, decision: decision.kind });

    if (decision.kind === 'availability') {
      try {
        const { block, slots } = await this.loadAvailability(turn);
        availabilityBlock = block;
        ({ state, decision } = this.reducer.reduce({
          transcript: excerpt,
          state,
          callerPhone: this.identity.callerPhone,
          slots,
        }));
        this.dialogue = state;
        this.trace?.({
          component: 'dialogue',
          event: 'reduced',
          turn,
          phase: state.phase,
          decision: decision.kind,
          availabilityChars: block.length,
          slots: slots.length,
        });
      } catch (err) {
        const detail = `availability-error: ${err instanceof Error ? err.message : String(err)}`;
        this.logPhase('availability', 'turn-error', { turn, detail });
        // Availability failures stay conversational: say the booking system
        // cannot be reached right now and keep the call alive.
        this.logFailure?.({ callSid: this.identity.callSid, turn, reason: 'low-confidence', excerpt, detail });
        this.logTurn?.({
          callSid: this.identity.callSid,
          turn,
          excerpt,
          reply: BOOKING_FAILURE_LINE,
          endCall: false,
          miss: false,
        });
        this.activeTurn = null;
        await this.speakSafe(BOOKING_FAILURE_LINE, true);
        return;
      }
      if (decision.kind === 'continue') {
        await this.answerWithModel(excerpt, turn, state, { availability: availabilityBlock });
        return;
      }
    }

    if (patientChanged && (await this.verifyCriticalFields(excerpt, turn, wav, state))) return;

    switch (decision.kind) {
      case 'speak': {
        this.finishDeterministic(excerpt, turn, decision.text);
        await this.speakSafe(decision.text, true);
        return;
      }
      case 'goodbye': {
        const goodbye = goodbyeFor(this.guide);
        this.finishDeterministic(excerpt, turn, goodbye, true);
        await this.speakSafe(goodbye);
        if (!this.closed) this.close('goodbye');
        return;
      }
      case 'readback': {
        const played = await this.speakReadback(decision.text);
        if (played) {
          this.logTurn?.({
            callSid: this.identity.callSid,
            turn,
            excerpt,
            reply: decision.text,
            endCall: false,
            miss: false,
          });
          this.activeTurn = null;
        }
        return;
      }
      case 'book': {
        await this.writeBooking(excerpt, turn, decision.slot, decision.patient);
        return;
      }
      case 'availability':
      case 'continue':
        await this.answerWithModel(excerpt, turn, state, { availability: availabilityBlock });
        return;
    }
  }

  private finishDeterministic(excerpt: string, turn: number, reply: string, endCall = false): void {
    this.logTurn?.({
      callSid: this.identity.callSid,
      turn,
      excerpt,
      reply,
      endCall,
      miss: false,
    });
    this.activeTurn = null;
  }

  private async speakSafe(text: string, commit = false): Promise<void> {
    try {
      await this.enqueueResponse(text, { kind: 'response', fixed: true, commit });
    } catch (err) {
      if (this.closed) return;
      const detail = ttsDetail(err);
      this.logFailure?.({ callSid: this.identity.callSid, turn: this.calls.get(this.identity.callSid).turn, reason: 'low-confidence', excerpt: '', detail });
      this.close('failure');
    }
  }

  private speakReadback(text: string): Promise<boolean> {
    return this.enqueueResponse(text, { kind: 'readback', fixed: false, commit: true }).then(
      () => !this.closed && this.dialogue.readback?.played === true,
      () => false,
    );
  }

  /**
   * Booking write: only after reducer authorization. Once the write has
   * started, transport interruption must never cancel it; only the spoken
   * outcome may be interrupted.
   */
  private async writeBooking(
    excerpt: string,
    turn: number,
    slot: SlotOption,
    patient: { name: string; phone: string },
  ): Promise<void> {
    this.setPhase('BOOKING');
    this.logPhase('booking', 'start', { turn, date: slot.date, time: slot.time, location: slot.location });
    let outcome: BookingOutcome;
    try {
      if (!this.onProposeBooking) {
        outcome = { ok: false, reason: 'booking is not available yet; the clinic will confirm shortly' };
      } else {
        outcome = await this.onProposeBooking({
          callSid: this.identity.callSid,
          turn,
          excerpt,
          slot: {
            service: slot.service,
            location: slot.location,
            date: slot.date,
            time: slot.time,
            callerName: patient.name,
            callerPhone: patient.phone,
          },
        });
      }
    } catch (err) {
      const detail = `booking-error: ${err instanceof Error ? err.message : String(err)}`;
      this.logPhase('booking', 'error', { turn, detail });
      await this.failTurn(excerpt, turn, detail, BOOKING_FAILURE_LINE);
      return;
    }
    const line = outcome.ok
      ? `Booked. ${patient.name} is confirmed for ${slot.service} at ${slot.location} on ${spokenDate(slot.date)} at ${spokenTime(slot.time)}.`
      : BOOKING_FAILURE_LINE;
    this.logPhase('booking', 'outcome', { turn, ok: outcome.ok, reason: outcome.ok ? undefined : outcome.reason });
    this.dialogue = { ...this.dialogue, phase: outcome.ok ? 'idle' : 'choosing-slot', readback: undefined, confirmation: undefined };
    this.logTurn?.({
      callSid: this.identity.callSid,
      turn,
      excerpt,
      reply: line,
      endCall: false,
      miss: false,
    });
    this.activeTurn = null;
    await this.speakSafe(line, true);
  }

  /**
   * Selective second decode: only when the dialogue state expects a critical
   * field. A material disagreement clarifies instead of guessing.
   */
  private async verifyCriticalFields(
    excerpt: string,
    turn: number,
    wav: Buffer | null,
    state: DialogueState,
  ): Promise<boolean> {
    if (!this.secondOpinion || !wav) return false;
    const critical =
      state.phase === 'collecting-patient' || state.phase === 'awaiting-confirmation' || state.phase === 'booking';
    if (!critical) return false;
    let second: Transcription;
    try {
      second = await this.secondOpinion.transcribe(wav, 'audio/wav');
    } catch (err) {
      this.trace?.({
        component: 'stt',
        event: 'second-opinion-error',
        turn,
        detail: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    if (!second.text.trim() || this.agreesWithPrimary(excerpt, second.text, state)) return false;
    this.trace?.({ component: 'stt', event: 'second-opinion-disagree', turn });
    const line = "Sorry, I want to make sure I have that exactly right. Could you repeat that for me?";
    this.logTurn?.({
      callSid: this.identity.callSid,
      turn,
      excerpt,
      reply: line,
      endCall: false,
      miss: true,
    });
    this.activeTurn = null;
    await this.speakSafe(line);
    return true;
  }

  private agreesWithPrimary(primary: string, second: string, state: DialogueState): boolean {
    const phone = state.patient.phone;
    if (phone) {
      const digits = phone.replace(/\D/g, '').slice(-10);
      if (digits.length >= 10 && !second.replace(/\D/g, '').includes(digits)) return false;
    }
    const name = state.patient.name;
    if (name) {
      const first = name.split(/\s+/)[0]!.toLowerCase();
      if (first.length > 2 && !primary.toLowerCase().includes(first) && !second.toLowerCase().includes(first)) {
        return false;
      }
    }
    return true;
  }

  /** LLM wording path: FAQ or controller-injected availability. */
  private async answerWithModel(
    excerpt: string,
    turn: number,
    state: DialogueState,
    extra: { availability?: string },
  ): Promise<void> {
    if (this.closed || !this.assistant) {
      this.beginListening();
      return;
    }
    if (this.loadGuide) {
      try {
        this.guide = await this.loadGuide();
      } catch {
        // Answer with the last good guide rather than failing the Turn.
      }
    }
    const assistant = this.assistant;
    if (this.activeTurn) this.activeTurn.excerpt = excerpt;
    const availabilityBlock =
      extra.availability ??
      (this.warmAvailability && this.warmAvailability.block !== null && Date.now() - this.warmAvailability.startedAt < WARM_AVAILABILITY_MS
        ? this.warmAvailability.block
        : undefined);
    if (availabilityBlock) {
      this.logPhase('availability', 'injected', { turn, chars: availabilityBlock.length });
    }
    const controller = new AbortController();
    const deadline = this.turnDeadlineMs > 0 ? setTimeout(() => controller.abort(), this.turnDeadlineMs) : null;
    deadline?.unref?.();    const ctx = {
      transcript: excerpt,
      history: [...this.calls.get(this.identity.callSid).history],
      guide: this.guide,
      callerPhone: this.identity.callerPhone,
      availability: availabilityBlock,
      sessionId: this.identity.callSid,
      dialogueAct: this.dialogueAct(state),
      // Only the reducer's chosen candidates are offered; the next short
      // answer can then be resolved against exactly these Slots.
      slotShortlist: state.lastOffered.map(
        (slot) => `${slot.date} ${slot.time} ${slot.service} at ${slot.location}`,
      ),
      onAssistantEvent: (event: AssistantEvent): void => {
        const { round, event: name, name: tool, ...fields } = event;
        this.logPhase('llm', name, { turn, round, tool, ...fields });
      },
      getAvailability: () => this.loadAvailability(turn).then((result) => result.block),
      proposeBooking: (): Promise<BookingOutcome> => {
        // The model no longer writes bookings: the controller reads back and
        // confirms first, then writes from validated state.
        return Promise.resolve({
          ok: false,
          reason: 'the controller confirms the readback with the caller before booking',
        });
      },
    };
    const source: AsyncIterable<string> = assistant.replyStream
      ? assistant.replyStream(ctx, controller.signal)
      : (async function* oneShot(): AsyncGenerator<string> {
          const out = await assistant.reply(ctx);
          yield out.text;
        })();
    const iterator = source[Symbol.asyncIterator]();
    let fullReply = '';
    let replyGeneration = 0;
    let generationCompleted = false;
    try {
      const first = await this.firstTokenOrHold(iterator);
      const result = await this.enqueueModelResponse(iterator, first, controller, turn, () => {
        // The deadline governs generation, not the time a finished reply takes
        // to play out; aborting during playback would reprompt after success.
        generationCompleted = true;
        if (deadline) clearTimeout(deadline);
      });
      fullReply = result.text;
      replyGeneration = result.generation;
    } catch (err) {
      if (deadline) clearTimeout(deadline);
      if (this.closed || this.activeTurn === null) return;
      if (isAbortError(err, controller.signal)) return;
      const raw = err instanceof Error ? err : new Error(String(err));
      const detail = /^(tts-error|assistant-error|availability-error|booking-error):/.test(raw.message)
        ? raw.message
        : `assistant-error: ${raw.message}`;
      await this.failTurn(excerpt, turn, detail, FAILURE_LINE);
      return;
    } finally {
      if (deadline) clearTimeout(deadline);
    }
    if (this.closed || this.activeTurn === null) return;
    // Barge-in: unheard wording never enters history, and the promoted Caller
    // utterance is already the next Turn.
    if (replyGeneration > 0 && replyGeneration <= this.cancelledThrough) return;
    if (controller.signal.aborted && !generationCompleted) {
      this.logPhase('turn', 'deadline', { turn, ms: this.turnDeadlineMs });
      this.logTurn?.({ callSid: this.identity.callSid, turn, excerpt, reply: REPROMPT_LINE, endCall: false, miss: true });
      this.activeTurn = null;
      await this.speakSafe(REPROMPT_LINE);
      return;
    }
    if (fullReply.trim() === '') {
      this.logPhase('assistant', 'empty', { turn });
      this.logFailure?.({
        callSid: this.identity.callSid,
        turn,
        reason: 'low-confidence',
        excerpt,
        detail: 'assistant-empty-reply',
      });
      this.logTurn?.({ callSid: this.identity.callSid, turn, excerpt, reply: REPROMPT_LINE, endCall: false, miss: true });
      this.activeTurn = null;
      await this.speakSafe(REPROMPT_LINE);
      return;
    }
    this.logTurn?.({
      callSid: this.identity.callSid,
      turn,
      excerpt,
      reply: fullReply,
      endCall: false,
      miss: false,
    });
    this.activeTurn = null;
  }

  /**
   * Wait for the first non-empty token; if the model is slower than the hold
   * budget, speak the holding line first. The iterator keeps its in-flight
   * `next()` so no token is lost.
   */
  private async firstTokenOrHold(iterator: AsyncIterator<string>): Promise<IteratorResult<string>> {
    const pending = iterator.next();
    if (this.holdAfterMs <= 0) return pending;
    let timer: NodeJS.Timeout | null = null;
    const hold = new Promise<'hold'>((resolve) => {
      timer = setTimeout(() => resolve('hold'), this.holdAfterMs);
      timer.unref?.();
    });
    try {
      const winner = await Promise.race([pending.then((result) => ({ result })), hold.then(() => 'hold' as const)]);
      if (winner === 'hold') {
        this.logPhase('assistant', 'hold', { text: HOLD_ASSISTANT_LINE });
        await this.speakFixed(HOLD_ASSISTANT_LINE);
        return pending;
      }
      return winner.result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** The LLM response is one logical TTS response; mark commit happens at its tail. */
  private enqueueModelResponse(
    iterator: AsyncIterator<string>,
    first: IteratorResult<string>,
    controller: AbortController,
    turn: number,
    onGenerationDone?: () => void,
  ): Promise<{ text: string; generation: number }> {
    const startedAt = Date.now();
    let firstToken = false;
    const run = this.speechTail.then(async () => {
      const generation = this.nextGeneration();
      const response = this.createSpeechResponse(generation);
      const speech: ActiveSpeech = {
        generation,
        text: '',
        kind: 'response',
        abort: controller,
        response,
        cancelled: false,
      };
      this.setPhase('SPEAKING');
      this.prepareSpeaking();
      this.activeSpeech = speech;
      try {
        const chunker = new VoiceChunker();
        let fullReply = '';
        const audioDrain = (async () => {
          for await (const chunk of response.audio()) {
            if (this.closed || speech.cancelled || generation !== this.generation) return;
            this.sendAudio(chunk);
          }
        })();
        let streamError: Error | undefined;
        try {
          let next = first;
          while (!next.done) {
            if (this.closed || speech.cancelled || generation !== this.generation) break;
            const token = next.value;
            if (token) {
              if (!firstToken) {
                firstToken = true;
                this.logPhase('assistant', 'first-token', { turn, ms: Date.now() - startedAt });
              }
              fullReply += token;
              if (this.activeTurn) this.activeTurn.replySoFar = fullReply;
              for (const phrase of chunker.push(token)) response.pushText(`${phrase} `);
            }
            next = await iterator.next();
          }
          // Only a stream that ran to its own end clears the deadline: an
          // aborted stream falls through to the reprompt path below.
          onGenerationDone?.();
        } catch (err) {
          if (!isAbortError(err, controller.signal) && !speech.cancelled) {
            streamError = err instanceof Error ? err : new Error(String(err));
          }
        }
        if (this.closed || speech.cancelled || generation !== this.generation) {
          response.cancel('generation-cancelled');
          return { text: fullReply, generation };
        }
        const tail = chunker.flush();
        if (tail) response.pushText(`${tail} `);
        speech.text = fullReply.trim();
        response.finishText();
        try {
          await audioDrain;
        } catch (err) {
          throw new Error(ttsDetail(err));
        }
        if (streamError) throw streamError;
        if (this.closed || speech.cancelled || generation !== this.generation) return { text: fullReply, generation };
        const result = await this.finishPlayback(generation);
        if (result.outcome === 'cleared') {
          this.onCleared(speech, result.reason);
          return { text: fullReply, generation };
        }
        this.trace?.({ component: 'twilio', event: 'playback-complete', generation });
        this.onPlaybackComplete?.(speech.text);
        this.logPhase('assistant', 'done', { turn, ms: Date.now() - startedAt, chars: fullReply.length });
        this.logPhase('tts', 'done', { generation, chars: speech.text.length });
        if (speech.text) this.calls.pushHistory(this.identity.callSid, { role: 'receptionist', text: speech.text });
        if (this.activeTurn) this.activeTurn.replySoFar = fullReply;
        return { text: fullReply, generation };
      } finally {
        this.activeSpeech = null;
        if (!this.closed && this.phase === 'SPEAKING') this.beginListening();
      }
    });
    this.speechTail = run.then(() => {}, () => {});
    return run;
  }

  private dialogueAct(state: DialogueState): string | undefined {
    if (state.offeredSlots.length > 0 && state.phase === 'choosing-slot') {
      return 'The caller wants an appointment. Offer one or two times from the live Slots and ask which one works. Do not confirm anything as booked.';
    }
    if (state.phase === 'collecting-patient') {
      return 'The caller is choosing a time. Ask only what is still missing; the controller handles the readback and booking.';
    }
    if (state.phase === 'awaiting-confirmation' || state.phase === 'booking') {
      return 'The controller handles confirmation and booking. Do not confirm a booking; answer briefly only.';
    }
    if (isAvailabilityIntent(state.intent)) {
      return 'Answer the caller about availability using only the live Slots in context.';
    }
    return undefined;
  }

  private scheduleHold(phase: string, text: string): () => void {
    if (this.holdAfterMs <= 0) return () => {};
    let settled = false;
    const timer = setTimeout(() => {
      if (settled || this.closed) return;
      settled = true;
      this.logPhase(phase, 'hold', { text });
      void this.enqueueResponse(text, { kind: 'response', fixed: true, commit: false }).catch(() => {});
    }, this.holdAfterMs);
    timer.unref?.();
    return () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
    };
  }

  /** One phase transition of a Turn; the handoff channel for where time went. */
  private logPhase(phase: string, event: string, fields: Record<string, unknown> = {}): void {
    this.logSession?.({
      callSid: this.identity.callSid,
      kind: 'phase',
      phase,
      event,
      ...fields,
    });
  }

  private async failTurn(excerpt: string, turn: number, detail: string, line: string): Promise<void> {
    this.logPhase('turn', 'error', { turn, detail });
    this.logFailure?.({ callSid: this.identity.callSid, turn, reason: 'low-confidence', excerpt, detail });
    try {
      await this.speakFixed(line);
    } catch {
      // TTS itself failed; the log above is the handoff channel.
    }
    this.logTurn?.({ callSid: this.identity.callSid, turn, excerpt, reply: line, endCall: true, miss: false });
    this.activeTurn = null;
    if (!this.closed) this.close('failure');
  }

  private async miss(excerpt: string, turn: number, detail: string | undefined): Promise<void> {
    const state = this.calls.get(this.identity.callSid);
    state.misses += 1;
    if (this.activeTurn) this.activeTurn.excerpt = excerpt;
    if (state.misses <= 2) {
      this.logTurn?.({
        callSid: this.identity.callSid,
        turn,
        excerpt,
        reply: REPROMPT_LINE,
        endCall: false,
        miss: true,
      });
      this.activeTurn = null;
      try {
        await this.speakFixed(REPROMPT_LINE);
      } catch (err) {
        const ttsCause = err instanceof Error ? `tts-error: ${err.message}` : `tts-error: ${String(err)}`;
        this.logFailure?.({ callSid: this.identity.callSid, turn, reason: 'low-confidence', excerpt, detail: ttsCause });
        this.close('failure');
      }
      return;
    }
    this.logFailure?.({ callSid: this.identity.callSid, turn, reason: 'low-confidence', excerpt, detail });
    const goodbye = goodbyeFor(this.guide);
    this.logTurn?.({ callSid: this.identity.callSid, turn, excerpt, reply: goodbye, endCall: true, miss: true });
    this.activeTurn = null;
    try {
      await this.speakFixed(goodbye);
    } catch {
      // Goodbye TTS failed; the failure log above is the handoff channel.
    }
    this.close('goodbye');
  }
}

export type { Tts };
export { FAILURE_LINE };
