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
  type AssistantContext,
  type AssistantEvent,
  type BookingOutcome,
  type ProposedSlot,
  type Transcriber,
  type Transcription,
} from './app.ts';
import { encodeWav } from './audio.ts';
import type { CallState, CallStore } from './calls.ts';
import type { ClinicGuide } from './clinic.ts';
import {
  DialogueReducer,
  emptyDialogueState,
  isAvailabilityIntent,
  parseAvailabilityBlock,
  spokenDate,
  spokenTime,
  type DialogueState,
  type SlotOption,
} from './dialogue.ts';
import { type BargeInEvent, type EndpointPolicy, type Utterance, type Vad } from './endpoint.ts';
import type { EchoGateOptions } from './echoGate.ts';
import type { FixedAudioCache } from './fixedAudio.ts';
import type { RealtimeStt } from './realtimeStt.ts';
import {
  classifySpeculation,
  guideBookingNames,
  partialAgrees,
  type SpeculationDecision,
} from './speculation.ts';
import type { PlaybackResult } from './transport.ts';
import type { StreamIdentity } from './stream.ts';
import type { TraceFn } from './trace.ts';
import { TurnTaking, type UtteranceSpeechStats } from './turnTaking.ts';
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
  /**
   * Warm the REST transcription route while the greeting plays, so the first
   * Turn does not pay the provider's cold start. The result is discarded.
   */
  warmTranscriber?: boolean;
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
  /** Sustained non-Echo Caller speech that fires a Barge-in while the Receptionist speaks. */
  bargeInMinSpeechMs?: number;
  /** Sub-threshold dip a Barge-in candidate tolerates before resetting. */
  bargeInDipToleranceMs?: number;
  /**
   * Partial transcripts arrive while the Receptionist speaks, so a Barge-in
   * candidate holds briefly for Backchannel classification. Defaults to the
   * realtime channel streaming partials.
   */
  partialSemantics?: boolean;
  /** How long the energy pre-trigger waits for partial semantics before taking the floor. */
  bargeInConfirmMs?: number;
  /** Echo-gate tuning; defaults ship the bench-tuned values. */
  echoGate?: EchoGateOptions;
  /**
   * Partial-transcript speculation: a clearly non-booking partial starts reply
   * generation early, kept when the final agrees and regenerated otherwise.
   * Defaults on; `false` runs every Turn from the final.
   */
  speculation?: boolean;
  /** Whole-Turn deadline for the LLM response. <=0 disables. */
  turnDeadlineMs?: number;
  /**
   * Bound on one Turn's REST transcription decodes (commit-time hedge, retry,
   * second opinion). A hung provider resolves the Turn with a reprompt instead
   * of pinning it. <=0 disables.
   */
  transcribeDeadlineMs?: number;
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
  /**
   * Ends the caller's phone call through the Twilio REST API. `failure` and
   * `goodbye` closes leave Twilio's `<Connect><Stream>` with no follow-up
   * TwiML, so without this the caller stays on a dead line — speaking into
   * silence until Twilio stops the stream on its own.
   */
  hangupCall?: (callSid: string) => Promise<void>;
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
 * A clause boundary this early still starts synthesis; waiting for the first
 * full sentence would hold every reply behind the model's punctuation. The
 * floor keeps one-word acknowledgements from becoming their own utterance.
 */
const CLAUSE_MIN_CHARS = 8;

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
    // Clause cuts, for replies whose first sentence is still streaming. Only
    // after a letter, so grouped digits ("1,000") never split.
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (ch !== ',' && ch !== ';') continue;
      if (i + 1 < CLAUSE_MIN_CHARS) continue;
      if (!/[a-z]/i.test(text[i - 1] ?? '')) continue;
      const next = text[i + 1];
      if (next !== undefined && !/\s/.test(next)) continue;
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

function isTranscribeTimeout(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('transcribe-timeout');
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
const DEFAULT_STT_DEADLINE_MS = 5000;

interface ActiveSpeech {
  generation: number;
  text: string;
  kind: 'response' | 'readback';
  abort: AbortController;
  response: SpeechResponse;
  cancelled: boolean;
  /** Started from a partial, before its Turn's final transcription landed. */
  speculative: boolean;
}

/** Which decoder supplied a Turn's transcript, for traces and tests. */
type TranscriptionSource = 'rest' | 'realtime' | 'realtime-empty-rest';

/**
 * Why a speculation was discarded. Every abort is traced with one of these.
 */
type SpeculationAbort =
  | 'booking-cue'
  | 'booking-final'
  | 'rewritten'
  | 'final-mismatch'
  | 'deterministic-turn'
  | 'empty-final'
  | 'transcribe-error'
  | 'generation-error'
  | 'call-closed';

/**
 * A reply generation started from a partial, before the Turn's final. The
 * first token pull runs immediately so the model works while the Caller is
 * still speaking; the session either keeps this stream for the Turn or aborts
 * it when the final disagrees.
 */
interface PendingSpeculation {
  partial: string;
  startedAt: number;
  controller: AbortController;
  iterator: AsyncIterator<string>;
  first: Promise<IteratorResult<string>>;
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
  private readonly warmTranscriber: boolean;
  private readonly tts: Tts;
  private guide: ClinicGuide;
  private readonly loadGuide: (() => Promise<ClinicGuide>) | undefined;
  private readonly assistant: Assistant | undefined;
  private readonly availability: string | (() => string | Promise<string>) | undefined;
  private readonly holdAfterMs: number;
  private readonly noResponseMs: number;
  private readonly availabilityTimeoutMs: number;
  private readonly turnDeadlineMs: number;
  private readonly transcribeDeadlineMs: number;
  private readonly fixedCache: FixedAudioCache | undefined;
  private readonly speculationEnabled: boolean;
  /** A partial-started generation awaiting its Turn's final. */
  private speculation: PendingSpeculation | null = null;
  /** Service, doctor, and Location names from the guide, for the cue classifier. */
  private cueNames: readonly string[];
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
  private readonly hangupCall?: (callSid: string) => Promise<void>;
  private phase: LivePhase = 'GREETING';
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
  private greeted = false;
  /** Serializes all outgoing speech so holds and replies never overlap. */
  private speechTail: Promise<void> = Promise.resolve();
  /** Monotonic response generation; every spoken response owns one. */
  private generation = 0;
  /** Highest generation whose first audio frame reached the transport. */
  private firstOutboundGeneration = 0;
  /** Responses at or below this generation were interrupted and must not play. */
  private cancelledThrough = 0;
  private activeSpeech: ActiveSpeech | null = null;
  /** Abort controller of the Turn's LLM generation, if one is running. */
  private turnAbort: AbortController | null = null;
  /**
   * Abort controller of the Turn's in-flight transcription decodes (hedge,
   * retry, second opinion). Barge-in and close abort it so a hung provider
   * cannot pin the Turn; late settlements never reach the session.
   */
  private transcribeAbort: AbortController | null = null;
  /** Abort controller of the on-open STT warm-up decode, if one is running. */
  private warmSttAbort: AbortController | null = null;
  /** Last Turn interrupted by a Barge-in; its pending generation must not speak. */
  private interruptedTurn = 0;
  /** Turn that already played a holding line; a Turn never stacks two. */
  private holdSpokenTurn = 0;
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
  /** Keypad digits buffered until `#` submits them as a phone number. */
  private dtmfBuffer = '';
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
    this.warmTranscriber = opts.warmTranscriber ?? false;
    this.tts = opts.tts;
    this.guide = opts.guide;
    this.loadGuide = opts.loadGuide;
    this.assistant = opts.assistant;
    this.availability = opts.availability;
    this.holdAfterMs = opts.holdAfterMs ?? 3000;
    this.noResponseMs = opts.noResponseMs ?? 0;
    this.availabilityTimeoutMs = opts.availabilityTimeoutMs ?? 0;
    this.turnDeadlineMs = opts.turnDeadlineMs ?? DEFAULT_TURN_DEADLINE_MS;
    this.transcribeDeadlineMs = opts.transcribeDeadlineMs ?? DEFAULT_STT_DEADLINE_MS;
    this.fixedCache = opts.fixedCache;
    this.speculationEnabled = opts.speculation ?? true;
    this.cueNames = guideBookingNames(this.guide.raw);
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
    this.hangupCall = opts.hangupCall;
    this.finishPlaybackFn =
      opts.finishPlayback ??
      (opts.waitForPlayback
        ? () => opts.waitForPlayback!().then((): PlaybackResult => ({ outcome: 'played', mark: '' }))
        : undefined);
    const realtimePartials = opts.realtime?.partials === true;
    this.turnTaking = new TurnTaking({
      vad: opts.vad,
      policy: opts.policy,
      bargeInMinSpeechMs: opts.bargeInMinSpeechMs,
      bargeInDipToleranceMs: opts.bargeInDipToleranceMs,
      // The provider's declaration, never the presence of a callback, decides
      // whether partials feed the semantic boundary and Backchannel semantics.
      partialSemantics: opts.partialSemantics ?? realtimePartials,
      bargeInConfirmMs: opts.bargeInConfirmMs,
      semanticBoundaries: realtimePartials,
      echoGate: opts.echoGate,
      observer: {
        onUtterance: (utterance, stats) => {
          this.pending = this.pending.then(() => this.handleUtterance(utterance, stats)).catch(() => {});
        },
        onBargeIn: (event) => this.handleBargeIn(event),
        onBackchannel: (event) => {
          // Absorbed and traced only: no Turn, no history, no reply. The trace
          // carries the evidence's size, never the Patient-sensitive text.
          this.trace?.({
            component: 'call',
            event: 'backchannel',
            durationMs: event.durationMs,
            chars: event.text.length,
          });
        },
        onSpeechStart: () => {
          this.cancelNoResponse();
          this.realtime?.speechStart();
        },
        onUpstreamFrame: (frame) => this.realtime?.pushAudio(frame),
        onEchoDecision: (decision) => {
          // One line per inbound frame while the Receptionist speaks, carrying
          // exactly the evidence the classification used.
          this.trace?.({
            component: 'echo-gate',
            event: 'decision',
            echo: decision.echo,
            reason: decision.reason,
            correlation: decision.evidence.correlation,
            delayMs: decision.evidence.delayMs,
            inboundRms: decision.evidence.inboundRms,
            referenceRms: decision.evidence.referenceRms,
            residualRms: decision.evidence.residualRms,
            returnLossDb: decision.evidence.returnLossDb,
            threshold: decision.evidence.threshold,
            marginDb: decision.evidence.marginDb,
          });
        },
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
    // before the Caller finishes; it can never write a Booking. The same
    // partials feed Backchannel classification while the floor is watched.
    // Only a provider that declares its partial channel is subscribed.
    if (realtimePartials) {
      opts.realtime?.onPartial?.((partial) => {
        this.turnTaking.observePartial(partial.text);
        this.handlePartial(partial.text);
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
    if (this.warmTranscriber) this.warmSttRoute();
    if (this.loadGuide) {
      try {
        this.adoptGuide(await this.loadGuide());
      } catch {
        // Greet with the injected guide rather than leaving the Caller on silence.
      }
    }
    await this.speakFixed(greetingFor(this.guide));
  }

  /** One write path for the guide, keeping the Booking-cue names in step. */
  private adoptGuide(guide: ClinicGuide): void {
    this.guide = guide;
    this.cueNames = guideBookingNames(guide.raw);
  }

  receiveAudio(mulaw: Buffer): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.turnTaking.receiveAudio(mulaw);
  }

  /**
   * Inbound keypad entry. Digits buffer until `#` submits a full number
   * (10-13 digits) through the normal dialogue path, so a keyed number gets
   * the same readback and booking safeguards as a spoken one. `*` clears.
   * Digits are never traced or logged; only lengths are.
   */
  receiveDtmf(digit: string): void {
    if (this.closed) return;
    if (digit === '*') {
      this.dtmfBuffer = '';
      this.trace?.({ component: 'call', event: 'dtmf-cleared' });
      return;
    }
    if (digit === '#') {
      this.submitDtmf();
      return;
    }
    if (!/^\d$/.test(digit) || this.dtmfBuffer.length >= 13) return;
    this.dtmfBuffer += digit;
    this.trace?.({ component: 'call', event: 'dtmf-digit', buffered: this.dtmfBuffer.length });
  }

  private submitDtmf(): void {
    const digits = this.dtmfBuffer;
    this.dtmfBuffer = '';
    if (digits.length < 10 || digits.length > 13) {
      this.trace?.({ component: 'call', event: 'dtmf-rejected', digits: digits.length });
      return;
    }
    const text = `my number is ${digits}`;
    // The keyed Turn enters the same serialized queue as a spoken utterance,
    // so it opens only after the previous Turn (and its reply) has settled and
    // never steals the active Turn's reply capture.
    this.pending = this.pending
      .then(() => {
        if (this.closed) return;
        const { turn, state } = this.beginTurn(text);
        state.misses = 0;
        this.setPhase('FINALIZING');
        this.trace?.({ component: 'call', event: 'dtmf-submit', turn, digits: digits.length });
        this.calls.pushHistory(this.identity.callSid, { role: 'caller', text });
        return this.reduceAndAnswer(text, turn, null, null);
      })
      .catch(() => {});
  }

  /**
   * One frame of outbound audio that actually played, retained as the Echo
   * reference. The transport calls this as it sends, so the reference is what
   * the Caller heard, not what was generated.
   */
  retainReference(mulaw: Buffer): void {
    if (this.closed) return;
    this.turnTaking.retainReference(mulaw);
  }

  /** Test seam: wait for queued utterance handlers. */
  async flush(): Promise<void> {
    await this.pending;
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

  /**
   * Single write path for dialogue state. The turn-taking module keys its
   * field-collection floor off the phase, so the local detector knows when the
   * Caller is dictating a name or phone number.
   */
  private setDialogue(state: DialogueState): void {
    this.dialogue = state;
    this.turnTaking.observeDialogueState(state.phase === 'collecting-patient');
  }

  /** Queue a whole logical response behind whatever is already playing. */
  private enqueueResponse(
    text: string | null,
    opts: { kind: 'response' | 'readback'; fixed: boolean; commit: boolean; generation?: number },
  ): Promise<void> {
    if (this.closed) return Promise.resolve();
    // Suspend listening immediately: the response may be queued behind another
    // one, and inbound audio must never endpoint into a new Turn meanwhile.
    if (this.activeSpeech === null && this.phase !== 'SPEAKING') this.prepareSpeaking(opts.kind);
    const generation = opts.generation ?? this.nextGeneration();
    const run = this.speechTail.then(() => this.runResponse(generation, text, opts));
    this.speechTail = run.catch(() => {});
    return run;
  }

  private nextGeneration(): number {
    this.generation += 1;
    return this.generation;
  }

  private errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  /**
   * One throwaway transcription while the greeting plays heats the REST STT
   * route (TCP/TLS and provider cold start) so the Caller's first Turn does
   * not pay it. The result is discarded and never becomes a Turn.
   */
  private warmSttRoute(): void {
    const started = Date.now();
    this.trace?.({ component: 'stt', event: 'warmup-start' });
    const controller = new AbortController();
    this.warmSttAbort = controller;
    const done = (): void => {
      if (this.warmSttAbort === controller) this.warmSttAbort = null;
    };
    this.transcriber.transcribe(encodeWav(new Int16Array(1600)), 'audio/wav', controller.signal).then(
      () => {
        done();
        this.trace?.({ component: 'stt', event: 'warmup-done', ms: Date.now() - started });
      },
      (err: unknown) => {
        done();
        this.trace?.({
          component: 'stt',
          event: 'warmup-error',
          ms: Date.now() - started,
          detail: this.errorText(err),
        });
      },
    );
  }

  /**
   * One Turn's REST decode, bounded by the transcription deadline and the
   * Turn's abort signal. The race holds the only continuation the session
   * awaits: a decode that settles after an abort or the deadline never reaches
   * the session, and a Hung provider rejects here instead of pinning the Turn.
   * `<=0` disables the deadline but still honours cancellation.
   */
  private awaitDecode(decode: Promise<Transcription>, signal: AbortSignal): Promise<Transcription> {
    if (signal.aborted) return Promise.reject(new Error('transcribe-aborted'));
    const deadlineMs = this.transcribeDeadlineMs;
    return new Promise<Transcription>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const done = (): void => {
        signal.removeEventListener('abort', onAbort);
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      };
      const onAbort = (): void => {
        done();
        reject(new Error('transcribe-aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (deadlineMs > 0) {
        timer = setTimeout(() => {
          done();
          reject(new Error(`transcribe-timeout after ${deadlineMs}ms`));
        }, deadlineMs);
        timer.unref?.();
      }
      decode.then(
        (result) => {
          done();
          resolve(result);
        },
        (err: unknown) => {
          done();
          reject(err);
        },
      );
    });
  }

  /**
   * The first audio frame of a reply is the Caller-observable start; trace it
   * once per generation so live analysis measures from last Caller speech.
   */
  private sendResponseAudio(generation: number, chunk: Buffer): void {
    if (generation > this.firstOutboundGeneration) {
      this.firstOutboundGeneration = generation;
      this.trace?.({ component: 'call', event: 'first-outbound', generation });
    }
    this.sendAudio(chunk);
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
      speculative: false,
    };
    this.setPhase('SPEAKING');
    this.prepareSpeaking(opts.kind);
    this.activeSpeech = speech;
    this.logPhase('tts', 'start', { generation, chars: text?.length ?? 0 });
    try {
      if (fixedBytes) {
        // Cache hits never touch the provider, but still pass through the
        // paced transport queue and the response-tail mark barrier.
        this.sendResponseAudio(generation, fixedBytes);
      } else if (text !== null) {
        const response = this.createSpeechResponse(generation, speech.abort.signal);
        speech.response = response;
        const collect = opts.fixed && this.fixedCache !== undefined;
        const chunks: Buffer[] = [];
        const audioDrain = (async () => {
          try {
            for await (const chunk of response.audio()) {
              if (this.closed || speech.cancelled || generation <= this.cancelledThrough) return;
              this.sendResponseAudio(generation, chunk);
              if (collect) chunks.push(chunk);
            }
          } catch (err) {
            if (speech.cancelled || generation <= this.cancelledThrough) return;
            throw err;
          }
        })();
        response.pushText(text);
        response.finishText();
        await audioDrain;
        if (collect && chunks.length > 0) this.fixedCache?.set(text, Buffer.concat(chunks));
      }
      if (speech.cancelled || this.closed || generation <= this.cancelledThrough) return;
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
        this.setDialogue(this.reducer.markReadbackPlayed(this.dialogue, generation));
      }
    } finally {
      this.activeSpeech = null;
      if (!this.closed && this.phase === 'SPEAKING') this.beginListening();
    }
  }

  private createSpeechResponse(generation: number, signal?: AbortSignal): SpeechResponse {
    if (this.tts.begin) {
      try {
        return this.tts.begin({ generation, ...(signal ? { signal } : {}) });
      } catch {
        // The streaming socket is unavailable (provider reject, socket drop):
        // fall back to the phrase-by-phrase path instead of failing the Turn.
      }
    }
    return bufferedSpeech(this.tts, {
      generation,
      ...(signal ? { signal } : {}),
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
      this.setDialogue(this.reducer.clearReadback(this.dialogue));
    }
  }

  /**
   * While speaking: always watch for Barge-in candidates over echo-gated
   * audio. Absorption is suspended during a readback, where any answer must
   * take the floor instead of being mistaken for an acknowledgement.
   */
  private prepareSpeaking(kind: 'response' | 'readback' = 'response'): void {
    this.turnTaking.startSpeaking({ absorbBackchannels: kind !== 'readback' });
    this.cancelNoResponse();
  }

  /** Sustained non-Echo Caller speech during a response: clear audio and open a new Turn. */
  private handleBargeIn(event: BargeInEvent): void {
    if (this.closed) return;
    const speech = this.activeSpeech;
    this.setPhase('INTERRUPTING');
    if (this.activeTurn) this.interruptedTurn = this.activeTurn.turn;
    this.trace?.({
      component: 'call',
      event: 'barge-in',
      generation: speech?.generation,
      candidateMs: event.durationMs,
    });
    this.clearPlaybackFn?.('caller-barge-in');
    if (speech) {
      speech.cancelled = true;
      speech.abort.abort('caller-barge-in');
      speech.response.cancel('caller-barge-in');
      this.cancelledThrough = speech.generation;
      if (speech.speculative) {
        this.trace?.({
          component: 'call',
          event: 'speculation-aborted',
          reason: 'caller-barge-in',
          generation: speech.generation,
        });
      }
      if (speech.kind === 'readback') this.setDialogue(this.reducer.clearReadback(this.dialogue));
    }
    // A reply still waiting on its first token (e.g. behind a hold line) is
    // aborted too, so the interrupted Turn never speaks after the Caller has
    // taken the floor.
    this.turnAbort?.abort('caller-barge-in');
    // Any transcription decode of the interrupted Turn is aborted as well: a
    // late transcript must never reach the session after the abort.
    this.transcribeAbort?.abort('caller-barge-in');
    this.transcribeAbort = null;
    this.activeSpeech = null;
    // The retained candidate becomes the start of the next utterance: the
    // first word is preserved instead of being dropped with the response.
    this.turnTaking.acceptBargeIn(event);
    this.setPhase('LISTENING');
    this.scheduleNoResponse();
  }

  /**
   * One partial from the live channel. A clearly non-booking partial starts a
   * speculative generation; a later partial that turns booking-sensitive or
   * rewrites the utterance aborts it. Availability prefetch stays reactive and
   * read-only.
   */
  private handlePartial(text: string): void {
    if (this.closed) return;
    const decision = classifySpeculation(text, { names: this.cueNames });
    if (this.speculation) {
      if (!decision.speculative) {
        this.abortSpeculation(this.speculation, 'booking-cue', decision.cue);
      } else if (!partialAgrees(this.speculation.partial, text)) {
        this.abortSpeculation(this.speculation, 'rewritten');
        if (this.canSpeculate()) this.startSpeculation(text, decision);
      }
    } else if (decision.speculative && this.canSpeculate()) {
      this.startSpeculation(text, decision);
    }
    this.warmAvailabilityForPartial(text);
  }

  /** Speculation needs an LLM stream and an open listening floor. */
  private canSpeculate(): boolean {
    return (
      this.speculationEnabled &&
      this.assistant?.replyStream !== undefined &&
      this.turnTaking.isListening &&
      this.activeTurn === null
    );
  }

  /**
   * Start the Turn before its final: the model streams text-only (Booking
   * tools suppressed) from the partial, and the first token pull runs now so
   * generation is already in flight when the Caller stops.
   */
  private startSpeculation(partial: string, decision: SpeculationDecision): void {
    const assistant = this.assistant;
    if (!assistant?.replyStream) return;
    const controller = new AbortController();
    const iterator = assistant.replyStream(this.speculativeContext(partial), controller.signal)[Symbol.asyncIterator]();
    const spec: PendingSpeculation = {
      partial,
      startedAt: Date.now(),
      controller,
      iterator,
      first: iterator.next(),
    };
    // A failure before the boundary must not surface as an unhandled rejection;
    // the Turn's handler awaits the same promise and falls back normally.
    spec.first.catch(() => {});
    this.speculation = spec;
    this.turnAbort = controller;
    this.trace?.({
      component: 'call',
      event: 'speculation-start',
      reason: decision.reason,
      chars: partial.length,
    });
    this.logPhase('speculation', 'start', { chars: partial.length, reason: decision.reason });
  }

  /** Assistant context for speculation: no tools, no writes, no history. */
  private speculativeContext(transcript: string): AssistantContext {
    // Speculation only runs on clearly non-booking partials, but the dialogue
    // may already be availability-intent; keep the same gate as a normal Turn.
    const availabilityBlock =
      this.dialogue.intent === 'availability' ? this.warmAvailabilityBlock() : undefined;
    return {
      transcript,
      history: [...this.calls.get(this.identity.callSid).history],
      guide: this.guide,
      callerPhone: this.identity.callerPhone,
      availability: availabilityBlock,
      sessionId: this.identity.callSid,
      dialogueAct: this.dialogueAct(this.dialogue),
      speculative: true,
      onAssistantEvent: (event: AssistantEvent): void => {
        const { round, event: name, name: tool, ...fields } = event;
        this.logPhase('llm', name, { round, tool, speculative: true, ...fields });
      },
      getAvailability: () => Promise.resolve(availabilityBlock ?? availabilityPlaceholder()),
      proposeBooking: (): Promise<BookingOutcome> =>
        Promise.resolve({ ok: false, reason: 'a speculative reply may not book' }),
    };
  }

  /**
   * Discard a speculation: abort its model stream, clear any audio it already
   * played, and make sure its text can never reach history. The trace keeps a
   * count and latency, never the Patient-sensitive partial itself.
   */
  private abortSpeculation(spec: PendingSpeculation, reason: SpeculationAbort, cue?: string): void {
    if (this.speculation === spec) this.speculation = null;
    spec.controller.abort(reason);
    if (this.turnAbort === spec.controller) this.turnAbort = null;
    const speech = this.activeSpeech;
    if (speech?.speculative) {
      speech.cancelled = true;
      speech.response.cancel(reason);
      this.cancelledThrough = Math.max(this.cancelledThrough, speech.generation);
      this.clearPlaybackFn?.(reason);
      this.activeSpeech = null;
    }
    this.trace?.({
      component: 'call',
      event: 'speculation-aborted',
      reason,
      cue,
      chars: spec.partial.length,
      ms: Date.now() - spec.startedAt,
    });
    this.logPhase('speculation', 'aborted', { reason, chars: spec.partial.length });
  }

  /** Await a kept speculation to its playback end and log the Turn. */
  private async settleSpeculation(
    run: Promise<{ text: string; generation: number }>,
    spec: PendingSpeculation,
    turn: number,
    excerpt: string,
  ): Promise<'spoke' | 'interrupted' | 'fallback'> {
    let result: { text: string; generation: number };
    try {
      result = await run;
    } catch (err) {
      if (this.closed || this.interruptedTurn === turn) return 'interrupted';
      this.trace?.({
        component: 'call',
        event: 'speculation-aborted',
        reason: 'generation-error',
        chars: spec.partial.length,
        detail: err instanceof Error ? err.message : String(err),
        ms: Date.now() - spec.startedAt,
      });
      return 'fallback';
    }
    if (this.closed) return 'interrupted';
    if (this.interruptedTurn === turn) return 'interrupted';
    if (result.generation === 0) return 'fallback';
    if (result.generation <= this.cancelledThrough) return 'interrupted';
    const reply = result.text.trim();
    if (reply === '') return 'fallback';
    this.calls.pushHistory(this.identity.callSid, { role: 'receptionist', text: reply });
    this.logTurn?.({
      callSid: this.identity.callSid,
      turn,
      excerpt,
      reply,
      endCall: false,
      miss: false,
    });
    this.activeTurn = null;
    return 'spoke';
  }

  /** Read-only Availability prefetch from an availability-intent partial. */
  private warmAvailabilityForPartial(text: string): void {
    if (this.partialWarmStarted || this.availabilityForTurn) return;
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
   * The controller-owned read with dead air bounded: while it is in flight, a
   * holding line speaks after the same budget the model's first token gets.
   * The bridge is not awaited — the model stream starts the moment the read
   * lands and queues behind it — and a bridge played here means the model's
   * own hold is skipped, so a Turn never stacks two holding lines.
   */
  private async loadAvailabilityCovered(turn: number): Promise<{ block: string; slots: SlotOption[] }> {
    const load = this.loadAvailability(turn);
    if (this.holdAfterMs <= 0 || this.holdSpokenTurn === turn) return load;
    let timer: NodeJS.Timeout | null = null;
    const hold = new Promise<'hold'>((resolve) => {
      timer = setTimeout(() => resolve('hold'), this.holdAfterMs);
      timer.unref?.();
    });
    try {
      const winner = await Promise.race([load.then((result) => ({ result })), hold.then(() => 'hold' as const)]);
      if (winner !== 'hold') return winner.result;
      this.holdSpokenTurn = turn;
      this.logPhase('availability', 'hold', { turn, text: HOLD_ASSISTANT_LINE });
      void this.speakFixed(HOLD_ASSISTANT_LINE).catch(() => {});
      return await load;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * The open-of-call Availability block while it is still fresh enough to
   * serve later Turns without a Picktime read.
   */
  private warmAvailabilityBlock(): string | undefined {
    const warm = this.warmAvailability;
    if (warm === null || warm.block === null) return undefined;
    return Date.now() - warm.startedAt < WARM_AVAILABILITY_MS ? warm.block : undefined;
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
    if (this.speculation) this.abortSpeculation(this.speculation, 'call-closed');
    // In-flight transcription decodes (hedge, second opinion, warm-up) are
    // aborted so a hung provider cannot outlive the call or reject unhandled.
    this.transcribeAbort?.abort('call-closed');
    this.transcribeAbort = null;
    this.warmSttAbort?.abort('call-closed');
    this.warmSttAbort = null;
    this.logSession?.({ callSid: this.identity.callSid, kind: 'session', event: 'close', reason });
    // Abort the Turn's LLM generation (queued model replies never start after
    // close) and the active speech signal (in-flight provider TTS requests
    // abort instead of only dropping late chunks).
    this.turnAbort?.abort('call-closed');
    this.turnAbort = null;
    this.activeSpeech?.abort.abort('call-closed');
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
    this.hangupViaRest(reason);
  }

  /**
   * Fire-and-forget REST hangup for locally-initiated call ends: Twilio learns
   * about `failure`/`goodbye` only through the phone network, and a dropped
   * stream alone leaves the Caller listening to dead air.
   */
  private hangupViaRest(reason: string): void {
    if (!this.hangupCall || (reason !== 'failure' && reason !== 'goodbye')) return;
    this.hangupCall(this.identity.callSid).then(
      () => this.trace?.({ component: 'twilio', event: 'rest-hangup', ok: true, reason }),
      (err) =>
        this.trace?.({
          component: 'twilio',
          event: 'rest-hangup',
          ok: false,
          reason,
          detail: err instanceof Error ? err.message : String(err),
        }),
    );
  }

  /**
   * Open the moving Turn: bump the shared counter, arm the reply-capture
   * record, and clear the no-response watch. Speech and keypad entry share
   * this, so a keyed number is a Turn like any other.
   */
  private beginTurn(excerpt: string): { turn: number; state: CallState } {
    this.cancelNoResponse();
    this.noResponsePrompts = 0;
    const state = this.calls.get(this.identity.callSid);
    state.turn += 1;
    const turn = state.turn;
    this.activeTurn = { turn, excerpt, replySoFar: '' };
    return { turn, state };
  }

  private async handleUtterance(utterance: Utterance, stats: UtteranceSpeechStats): Promise<void> {
    if (this.closed) return;
    const { turn, state } = this.beginTurn('');
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
      speechMs: utterance.durationMs,
      trailingSilenceMs: utterance.trailingSilenceMs,
      frames: stats.frames,
      maxScore: stats.maxScore,
      meanScore: stats.meanScore,
    });
    // The partial-started generation becomes this Turn's.
    const speculation = this.speculation;
    this.speculation = null;
    let speculativeRun: Promise<{ text: string; generation: number }> | null = null;
    let historyPushed = false;
    if (speculation) {
      speculativeRun = this.speakSpeculation(turn, speculation);
      speculativeRun.catch(() => {});
    }
    let text = '';
    const transcribeStarted = Date.now();
    this.logPhase('transcribe', 'start', { turn });
    let wav: Buffer | null = null;
    // A name or phone number is being dictated: start the selective second
    // decode alongside the primary transcription instead of serializing it
    // after the dialogue has already decided. Verification gates the commit.
    let secondOpinion: Promise<Transcription> | null = null;
    const prePhase = this.dialogue.phase;
    const criticalPrePhase =
      prePhase === 'collecting-patient' || prePhase === 'awaiting-confirmation' || prePhase === 'booking';
    // One Turn, one transcription controller: barge-in and close abort every
    // decode of this Turn (hedge, retry, second opinion) instead of letting
    // them run to completion and dropping the result.
    const transcribeAbort = new AbortController();
    this.transcribeAbort = transcribeAbort;
    const transcribeSignal = transcribeAbort.signal;
    try {
      wav = encodeWav(utterance.audio);
      this.onUtteranceAudio?.({ callSid: this.identity.callSid, turn, wav });
      if (this.secondOpinion && criticalPrePhase) {
        secondOpinion = this.secondOpinion.transcribe(wav, 'audio/wav', transcribeSignal);
        secondOpinion.catch(() => {});
        this.trace?.({ component: 'stt', event: 'second-opinion-start', turn });
      }
      let tx: Transcription | null = null;
      let source: TranscriptionSource = 'rest';
      // Commit-time hedge: the REST decode starts the moment the utterance is
      // committed to the realtime channel, so an empty final never pays the
      // commit-to-final wait and then a fresh REST decode on top.
      let rest: Promise<Transcription> | null = null;
      const startRest = (): Promise<Transcription> => {
        if (rest === null) {
          rest = this.transcriber.transcribe(wav!, 'audio/wav', transcribeSignal);
          rest.catch((err: unknown) =>
            this.trace?.({ component: 'stt', event: 'hedge-error', turn, detail: this.errorText(err) }),
          );
          this.trace?.({ component: 'stt', event: 'hedge-start', turn });
        }
        return rest;
      };
      if (this.realtime) {
        startRest();
        const finalize = this.realtime.finalize();
        const settledFinal = finalize.then(
          (t) => ({ kind: 'final' as const, t }),
          (err: unknown) => ({ kind: 'final-error' as const, err }),
        );
        const settled = await settledFinal;
        // The Turn is gone (barge-in, close): a late final must not revive it.
        if (this.closed || transcribeSignal.aborted) return;
        if (settled.kind === 'final') {
          // A non-empty realtime final is preferred whenever it lands, even
          // when the REST hedge already returned.
          tx = settled.t;
          source = 'realtime';
          if (settled.t.text.trim()) this.trace?.({ component: 'stt', event: 'hedge-lost', turn });
        } else {
          this.logPhase('transcribe', 'fallback', {
            turn,
            ms: Date.now() - transcribeStarted,
            detail: this.errorText(settled.err),
          });
          if (this.closed) return;
        }
      }
      // An empty realtime final uses the decode already in flight; a REST
      // failure with a realtime result never overrides it. The REST wait is
      // bounded: a hung provider resolves the Turn with a reprompt instead of
      // pinning it, while a realtime final already in hand still stands.
      if (!tx || !tx.text.trim()) {
        let result: Transcription;
        try {
          result = await this.awaitDecode(
            rest ?? this.transcriber.transcribe(wav, 'audio/wav', transcribeSignal),
            transcribeSignal,
          );
        } catch (err) {
          // The Turn is gone (barge-in, close): no late transcript, no late
          // reprompt, no unhandled rejection.
          if (this.closed || transcribeSignal.aborted) return;
          if (isTranscribeTimeout(err)) {
            // Cancel the hung provider call, then take the normal speakable
            // recovery path with the timeout reason on the trace.
            transcribeAbort.abort('transcribe-timeout');
            this.trace?.({ component: 'stt', event: 'deadline', turn, ms: this.transcribeDeadlineMs });
            this.logPhase('transcribe', 'timeout', { turn, ms: Date.now() - transcribeStarted });
            if (speculation) this.abortSpeculation(speculation, 'transcribe-error');
            await this.miss(text, turn, `transcribe-timeout after ${this.transcribeDeadlineMs}ms`);
            return;
          }
          if (!tx) throw err;
          result = tx;
        }
        if (result.text.trim() || !tx) {
          tx = result;
          if (source === 'realtime') source = 'realtime-empty-rest';
          if (result.text.trim()) this.trace?.({ component: 'stt', event: 'hedge-win', turn });
        }
      }
      if (this.closed || transcribeSignal.aborted) return;
      this.logPhase('transcribe', 'done', {
        turn,
        ms: Date.now() - transcribeStarted,
        chars: tx.text.length,
        noSpeech: tx.noSpeech,
        source,
      });
      if (!tx.text.trim() || tx.noSpeech) {
        if (speculation) this.abortSpeculation(speculation, 'empty-final');
        await this.miss(tx.text, turn, undefined);
        return;
      }
      text = tx.text;
      if (wav) this.onUtteranceTranscribed?.({ callSid: this.identity.callSid, turn, text: tx.text, wav });
    } catch (err) {
      if (this.closed || transcribeSignal.aborted) return;
      if (speculation) this.abortSpeculation(speculation, 'transcribe-error');
      const detail = err instanceof Error ? `transcribe-error: ${err.message}` : `transcribe-error: ${String(err)}`;
      this.logPhase('transcribe', 'error', { turn, ms: Date.now() - transcribeStarted, detail });
      await this.miss(text, turn, detail);
      return;
    }
    state.misses = 0;
    if (this.activeTurn) this.activeTurn.excerpt = text;
    // The final landed: keep the speculative reply only when it agrees with
    // the final AND the final's own dialogue decision is the model path. Any
    // deterministic decision aborts the speculation and regenerates.
    if (speculation && speculativeRun) {
      const before = this.dialogue;
      const probe = this.reducer.reduce({
        transcript: text,
        state: before,
        callerPhone: this.identity.callerPhone,
      });
      const patientChanged =
        probe.state.patient.name !== before.patient.name || probe.state.patient.phone !== before.patient.phone;
      const agrees = partialAgrees(speculation.partial, text);
      // A final that itself turned booking-sensitive always waits out the
      // speculation: partials can lag, so the last word is not the last word.
      const finalDecision = classifySpeculation(text, { names: this.cueNames });
      if (agrees && finalDecision.speculative && probe.decision.kind === 'continue' && !patientChanged) {
        this.setDialogue(probe.state);
        this.calls.pushHistory(this.identity.callSid, { role: 'caller', text });
        historyPushed = true;
        this.trace?.({
          component: 'call',
          event: 'speculation-kept',
          turn,
          chars: text.length,
          ms: Date.now() - speculation.startedAt,
        });
        this.logPhase('speculation', 'kept', { turn, ms: Date.now() - speculation.startedAt });
        if ((await this.settleSpeculation(speculativeRun, speculation, turn, text)) !== 'fallback') return;
      } else {
        this.abortSpeculation(
          speculation,
          !agrees ? 'final-mismatch' : finalDecision.speculative ? 'deterministic-turn' : 'booking-final',
          finalDecision.speculative ? undefined : finalDecision.cue,
        );
      }
    }
    if (!historyPushed) this.calls.pushHistory(this.identity.callSid, { role: 'caller', text });
    await this.reduceAndAnswer(text, turn, wav, secondOpinion, transcribeSignal);
  }

  /**
   * Feed the speculative stream through the normal speech pipeline. The first
   * token was already pulled when the speculation started, so playback can
   * begin as soon as the Turn boundary arrives.
   */
  private speakSpeculation(
    turn: number,
    spec: PendingSpeculation,
  ): Promise<{ text: string; generation: number }> {
    return this.firstTokenOrHold(spec.iterator, turn, spec.first).then((first) =>
      this.enqueueModelResponse(spec.iterator, first, spec.controller, turn, {
        speculative: true,
        commitHistory: false,
      }),
    );
  }

  /**
   * Controller-first Turn: reduce the transcript into a dialogue decision and
   * execute it. Only `continue`/`availability` reach the LLM; reads, field
   * questions, readbacks, writes, and goodbyes are deterministic.
   */
  private async reduceAndAnswer(
    excerpt: string,
    turn: number,
    wav: Buffer | null,
    prestartedSecondOpinion: Promise<Transcription> | null = null,
    transcribeSignal?: AbortSignal,
  ): Promise<void> {
    this.setPhase('PLANNING');
    const before = this.dialogue;
    let availabilityBlock: string | undefined;
    let { state, decision } = this.reducer.reduce({
      transcript: excerpt,
      state: this.dialogue,
      callerPhone: this.identity.callerPhone,
    });
    const patientChanged =
      state.patient.name !== before.patient.name || state.patient.phone !== before.patient.phone;
    this.trace?.({ component: 'dialogue', event: 'reduced', turn, phase: state.phase, decision: decision.kind });

    if (decision.kind === 'availability') {
      try {
        const { block, slots } = await this.loadAvailabilityCovered(turn);
        availabilityBlock = block;
        ({ state, decision } = this.reducer.reduce({
          transcript: excerpt,
          state,
          callerPhone: this.identity.callerPhone,
          slots,
        }));
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
        this.setDialogue(state);
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
        this.setDialogue(state);
        await this.answerWithModel(excerpt, turn, state, { availability: availabilityBlock });
        return;
      }
    }

    // A critical field only becomes dialogue state after the second decode
    // agrees; a disagreement clarifies while the prior state stays intact.
    if (patientChanged) {
      const second =
        prestartedSecondOpinion ??
        (this.secondOpinion && wav ? this.secondOpinion.transcribe(wav, 'audio/wav', transcribeSignal) : null);
      if (await this.verifyCriticalFields(excerpt, turn, second, state, transcribeSignal)) return;
    }
    this.setDialogue(state);

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
    this.setDialogue({ ...this.dialogue, phase: outcome.ok ? 'idle' : 'choosing-slot', readback: undefined, confirmation: undefined });
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
   * Selective second decode: only when the dialogue changed a critical field.
   * The decode promise is started by the caller (alongside the primary
   * transcription when dictation is expected, serially otherwise). A material
   * disagreement clarifies instead of guessing and blocks the state commit.
   */
  private async verifyCriticalFields(
    excerpt: string,
    turn: number,
    second: Promise<Transcription> | null,
    state: DialogueState,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!second) return false;
    let result: Transcription;
    try {
      result = await (signal ? this.awaitDecode(second, signal) : second);
    } catch (err) {
      // The Turn is gone (barge-in, close): stay silent and commit nothing.
      if (this.closed || signal?.aborted) return true;
      if (isTranscribeTimeout(err)) {
        this.trace?.({ component: 'stt', event: 'deadline', turn, scope: 'second-opinion' });
        this.logPhase('transcribe', 'timeout', { turn, scope: 'second-opinion' });
        return false;
      }
      this.trace?.({
        component: 'stt',
        event: 'second-opinion-error',
        turn,
        detail: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    if (!result.text.trim() || this.agreesWithPrimary(excerpt, result.text, state)) return false;
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
        this.adoptGuide(await this.loadGuide());
      } catch {
        // Answer with the last good guide rather than failing the Turn.
      }
    }
    const assistant = this.assistant;
    if (this.activeTurn) this.activeTurn.excerpt = excerpt;
    // The full block is per-Turn prefill cost: only a Turn that is actually
    // about availability gets it; every other Turn answers from the guide.
    const availabilityBlock =
      extra.availability ?? (state.intent === 'availability' ? this.warmAvailabilityBlock() : undefined);
    if (availabilityBlock) {
      this.logPhase('availability', 'injected', { turn, chars: availabilityBlock.length });
    }
    const controller = new AbortController();
    this.turnAbort = controller;
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
    let deadlineOutcome: 'completed-buffered' | 'cleared' | null = null;
    try {
      const first = await this.firstTokenOrHold(iterator, turn);
      const result = await this.enqueueModelResponse(iterator, first, controller, turn, {
        onGenerationDone: () => {
          // The deadline governs generation, not the time a finished reply takes
          // to play out; aborting during playback would reprompt after success.
          generationCompleted = true;
          if (deadline) clearTimeout(deadline);
        },
      });
      fullReply = result.text;
      replyGeneration = result.generation;
      deadlineOutcome = result.deadline;
    } catch (err) {
      if (deadline) clearTimeout(deadline);
      if (this.closed || this.activeTurn === null) return;
      if (isAbortError(err, controller.signal)) {
        // A Barge-in owns the Turn: its promoted utterance is already the next
        // Turn. A deadline abort before any speakable reply buffered heard
        // nothing to answer, so reprompt and return the floor instead of
        // leaving the call silent.
        if (this.interruptedTurn === turn || generationCompleted) return;
        this.logPhase('turn', 'deadline', { turn, ms: this.turnDeadlineMs, outcome: 'cleared-reprompt' });
        this.logTurn?.({ callSid: this.identity.callSid, turn, excerpt, reply: REPROMPT_LINE, endCall: false, miss: true });
        this.activeTurn = null;
        await this.speakSafe(REPROMPT_LINE);
        return;
      }
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
    // utterance is already the next Turn. A reply waiting behind a hold line
    // is aborted before it ever speaks.
    if (replyGeneration > 0 && replyGeneration <= this.cancelledThrough) return;
    if (this.interruptedTurn === turn) return;
    // The Turn deadline is traced exactly once, with the Turn's single
    // recovery outcome. The mid-stream decision lives in
    // enqueueModelResponse, which sees what the chunker already pushed to TTS.
    if (deadlineOutcome !== null) {
      const outcome = deadlineOutcome === 'cleared' ? 'cleared-reprompt' : 'completed-buffered';
      this.logPhase('turn', 'deadline', { turn, ms: this.turnDeadlineMs, outcome });
      if (deadlineOutcome === 'cleared') {
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
      return;
    }
    if (controller.signal.aborted && generationCompleted) {
      // The deadline fired but the provider finished anyway, so the complete
      // reply stands: still trace the deadline once, with its outcome.
      this.logPhase('turn', 'deadline', { turn, ms: this.turnDeadlineMs, outcome: 'completed-full' });
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
   * `next()` so no token is lost. A Turn that already bridged an Availability
   * read speaks no second hold.
   */
  private async firstTokenOrHold(
    iterator: AsyncIterator<string>,
    turn: number,
    pending: Promise<IteratorResult<string>> = iterator.next(),
  ): Promise<IteratorResult<string>> {
    if (this.holdAfterMs <= 0 || this.holdSpokenTurn === turn) return pending;
    let timer: NodeJS.Timeout | null = null;
    const hold = new Promise<'hold'>((resolve) => {
      timer = setTimeout(() => resolve('hold'), this.holdAfterMs);
      timer.unref?.();
    });
    try {
      const winner = await Promise.race([pending.then((result) => ({ result })), hold.then(() => 'hold' as const)]);
      if (winner === 'hold') {
        this.holdSpokenTurn = turn;
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
    opts: { speculative?: boolean; commitHistory?: boolean; onGenerationDone?: () => void } = {},
  ): Promise<{ text: string; generation: number; deadline: 'completed-buffered' | 'cleared' | null }> {
    const speculative = opts.speculative === true;
    const startedAt = Date.now();
    let firstToken = false;
    const run = this.speechTail.then(async () => {
      // Barge-in during the hold line marks the Turn interrupted before this
      // run starts; the interrupted Turn must not speak once the Caller has
      // taken the floor. An aborted speculation must not speak either.
      if (this.closed || this.interruptedTurn === turn || (speculative && controller.signal.aborted)) {
        if (this.turnAbort === controller) this.turnAbort = null;
        return { text: '', generation: 0, deadline: null };
      }
      const generation = this.nextGeneration();
      // Dedicated speech signal: barge-in and close abort the provider TTS
      // request through it, while the Turn deadline only aborts the LLM
      // generation — a generation that completes on the deadline edge is
      // still spoken, so its audio must not be cancelled with the deadline.
      const speechAbort = new AbortController();
      const response = this.createSpeechResponse(generation, speechAbort.signal);
      const speech: ActiveSpeech = {
        generation,
        text: '',
        kind: 'response',
        abort: speechAbort,
        response,
        cancelled: false,
        speculative,
      };
      this.setPhase('SPEAKING');
      this.prepareSpeaking();
      this.activeSpeech = speech;
      try {
        const chunker = new VoiceChunker();
        let fullReply = '';
        /** Complete phrases already pushed to TTS: the safe-to-finish prefix. */
        const pushedPhrases: string[] = [];
        const audioDrain = (async () => {
          for await (const chunk of response.audio()) {
            if (this.closed || speech.cancelled || generation <= this.cancelledThrough) return;
            this.sendResponseAudio(generation, chunk);
          }
        })();        let streamError: Error | undefined;
        // Set when the Turn deadline stops token flow mid-reply while speech
        // is still live. The recovery decision below owns the Turn: either the
        // safe buffered prefix plays out, or playback clears for one reprompt.
        let deadlineAborted = false;
        try {
          let next = first;
          while (!next.done) {
            if (this.closed || speech.cancelled || generation <= this.cancelledThrough) break;
            const token = next.value;
            if (token) {
              if (!firstToken) {
                firstToken = true;
                this.logPhase('assistant', 'first-token', { turn, ms: Date.now() - startedAt });
              }
              fullReply += token;
              if (this.activeTurn) this.activeTurn.replySoFar = fullReply;
              for (const phrase of chunker.push(token)) {
                pushedPhrases.push(phrase);
                response.pushText(`${phrase} `);
              }
            }
            next = await iterator.next();
          }
          // Only a stream that ran to its own end clears the deadline: an
          // aborted stream falls through to the reprompt path below.
          opts.onGenerationDone?.();
        } catch (err) {
          if (!isAbortError(err, controller.signal) && !speech.cancelled) {
            streamError = err instanceof Error ? err : new Error(String(err));
          } else if (
            controller.signal.aborted &&
            !this.closed &&
            !speech.cancelled &&
            generation > this.cancelledThrough
          ) {
            // The abort stopped token flow but speech is still live and owned
            // by this Turn (barge-in and close cancel the speech above), so
            // this is the Turn deadline: recover exactly once below.
            deadlineAborted = true;
          }
        }
        if (deadlineAborted) {
          // One coherent recovery, never a truncated reply plus a second
          // reply. Complete phrases already pushed to TTS are safe to finish;
          // the incomplete tail fragment stays unspoken either way.
          const played = pushedPhrases.join(' ').trim();
          if (played === '') {
            // Nothing speakable buffered: drop any partial audio and let the
            // Turn fall back to a single reprompt. The truncated text never
            // enters history.
            speech.cancelled = true;
            response.cancel('turn-deadline');
            this.clearPlaybackFn?.('turn-deadline');
            if (this.activeTurn) this.activeTurn.replySoFar = '';
            return { text: '', generation, deadline: 'cleared' as const };
          }
          speech.text = played;
          if (this.activeTurn) this.activeTurn.replySoFar = played;
          response.finishText();
          try {
            await audioDrain;
          } catch (err) {
            throw new Error(ttsDetail(err));
          }
          if (this.closed || speech.cancelled || generation <= this.cancelledThrough) {
            response.cancel('generation-cancelled');
            return { text: played, generation, deadline: null };
          }
          const outcome = await this.finishPlayback(generation);
          if (outcome.outcome === 'cleared') {
            this.onCleared(speech, outcome.reason);
            return { text: played, generation, deadline: null };
          }
          this.trace?.({ component: 'twilio', event: 'playback-complete', generation });
          this.onPlaybackComplete?.(speech.text);
          this.logPhase('assistant', 'done', { turn, ms: Date.now() - startedAt, chars: played.length });
          this.logPhase('tts', 'done', { generation, chars: speech.text.length });
          // A speculative reply's text commits in the keep path, in history
          // order behind the final Caller utterance.
          if (opts.commitHistory !== false && speech.text) {
            this.calls.pushHistory(this.identity.callSid, { role: 'receptionist', text: speech.text });
          }
          if (this.activeTurn) this.activeTurn.replySoFar = played;
          return { text: played, generation, deadline: 'completed-buffered' as const };
        }
        if (this.closed || speech.cancelled || generation <= this.cancelledThrough) {
          response.cancel('generation-cancelled');
          return { text: fullReply, generation, deadline: null };
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
        if (this.closed || speech.cancelled || generation <= this.cancelledThrough) return { text: fullReply, generation, deadline: null };
        const result = await this.finishPlayback(generation);
        if (result.outcome === 'cleared') {
          this.onCleared(speech, result.reason);
          return { text: fullReply, generation, deadline: null };
        }
        this.trace?.({ component: 'twilio', event: 'playback-complete', generation });
        this.onPlaybackComplete?.(speech.text);
        this.logPhase('assistant', 'done', { turn, ms: Date.now() - startedAt, chars: fullReply.length });
        this.logPhase('tts', 'done', { generation, chars: speech.text.length });
        // A speculative reply's text commits in the keep path, in history
        // order behind the final Caller utterance.
        if (opts.commitHistory !== false && speech.text) {
          this.calls.pushHistory(this.identity.callSid, { role: 'receptionist', text: speech.text });
        }
        if (this.activeTurn) this.activeTurn.replySoFar = fullReply;
        return { text: fullReply, generation, deadline: null };
      } finally {
        if (this.turnAbort === controller) this.turnAbort = null;
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
