import {
  availabilityPlaceholder,
  BOOKING_FAILURE_LINE,
  FAILURE_LINE,
  greetingFor,
  goodbyeFor,
  HOLD_ASSISTANT_LINE,
  REPROMPT_LINE,
  type Assistant,
  type BookingOutcome,
  type ProposedSlot,
  type Transcriber,
} from './app.ts';
import { encodeWav } from './audio.ts';
import type { CallStore } from './calls.ts';
import type { ClinicGuide } from './clinic.ts';
import { Endpointer, type EndpointPolicy, type Utterance, type Vad } from './endpoint.ts';
import type { StreamIdentity } from './stream.ts';
import type { Tts } from './tts.ts';
import type { FailureEvent, TurnEvent } from './app.ts';

export interface LiveProposeBookingArgs {
  callSid: string;
  turn: number;
  excerpt: string;
  slot: ProposedSlot;
}

export interface LiveCallOptions {
  identity: StreamIdentity;
  sendAudio: (audio: Buffer) => void;
  vad: Vad;
  policy: EndpointPolicy;
  transcriber: Transcriber;
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
  /** Overall deadline for the Availability read. <=0 waits forever. */
  availabilityTimeoutMs?: number;
  /** Single-attempt booking proposal, same seam as the legacy loop. */
  onProposeBooking?: (args: LiveProposeBookingArgs) => Promise<BookingOutcome>;
  calls: CallStore;
  logTurn?: (event: TurnEvent) => void;
  logFailure?: (event: FailureEvent) => void;
  onUtteranceLog?: (entry: { callSid: string; durationMs: number; bytes: number }) => void;
  /** Session lifecycle + VAD diagnostics; the console handoff channel. */
  logSession?: (event: Record<string, unknown>) => void;
  /** Playback-completion signal the Endpointing timer keys off. */
  onPlaybackComplete?: (text: string) => void;
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

function ttsDetail(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.startsWith('tts-error:') ? msg : `tts-error: ${msg}`;
}

/**
 * One call's live loop slice for tickets 09+10: greeting spoken in-session
 * through TTS, endpointed utterances transcribed through the unchanged
 * transcriber seam, misses counted toward the bounded-reprompt policy
 * (reprompt twice, handoff + close on the third miss per ticket 12).
 * Ticket 11 adds the assistant reply leg: streamed tokens are cut at
 * sentence boundaries and each finished sentence is spoken immediately.
 */
export class LiveCallSession {
  private readonly identity: StreamIdentity;
  private readonly sendAudio: (audio: Buffer) => void;
  private readonly endpointer: Endpointer;
  private readonly transcriber: Transcriber;
  private readonly tts: Tts;
  private guide: ClinicGuide;
  private readonly loadGuide: (() => Promise<ClinicGuide>) | undefined;
  private readonly assistant: Assistant | undefined;
  private readonly availability: string | (() => string | Promise<string>) | undefined;
  private readonly holdAfterMs: number;
  private readonly availabilityTimeoutMs: number;
  private readonly onProposeBooking:
    | ((args: LiveProposeBookingArgs) => Promise<BookingOutcome>)
    | undefined;
  private readonly calls: CallStore;
  private readonly logTurn?: (event: TurnEvent) => void;
  private readonly logFailure?: (event: FailureEvent) => void;
  private readonly onUtteranceLog?: (entry: { callSid: string; durationMs: number; bytes: number }) => void;
  private readonly logSession?: (event: Record<string, unknown>) => void;
  private readonly onPlaybackComplete?: (text: string) => void;
  private readonly onCloseCb?: (reason: string) => void;
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
  private greeted = false;
  /** Serializes all outgoing speech so holds and replies never overlap. */
  private speechTail: Promise<void> = Promise.resolve();
  /** One Availability read per Turn, however many times the assistant asks. */
  private availabilityForTurn: { turn: number; value: Promise<string> } | null = null;
  private scoreStats = { n: 0, max: 0, latched: false };
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
    this.tts = opts.tts;
    this.guide = opts.guide;
    this.loadGuide = opts.loadGuide;
    this.assistant = opts.assistant;
    this.availability = opts.availability;
    this.holdAfterMs = opts.holdAfterMs ?? 3000;
    this.availabilityTimeoutMs = opts.availabilityTimeoutMs ?? 0;
    this.onProposeBooking = opts.onProposeBooking;
    this.calls = opts.calls;
    this.logTurn = opts.logTurn;
    this.logFailure = opts.logFailure;
    this.onUtteranceLog = opts.onUtteranceLog;
    this.logSession = opts.logSession;
    this.onPlaybackComplete = opts.onPlaybackComplete;
    this.onCloseCb = opts.onClose;
    this.endpointer = new Endpointer(opts.vad, opts.policy, {
      onUtterance: (utterance) => {
        this.pending = this.pending.then(() => this.handleUtterance(utterance)).catch(() => {});
      },
      onScore: (score, latched) => {
        this.scoreStats.n += 1;
        if (score > this.scoreStats.max) this.scoreStats.max = score;
        if (latched) this.scoreStats.latched = true;
      },
    });
    // VAD summary every 2 s while audio flows: max score and whether the
    // latch ever fired. This is how a silent live call gets diagnosed.
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
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Session open: greet through the session's own TTS path (one voice). */
  async open(): Promise<void> {
    if (this.closed || this.greeted) return;
    this.greeted = true;
    this.logSession?.({ callSid: this.identity.callSid, kind: 'session', event: 'open' });
    if (this.loadGuide) {
      try {
        this.guide = await this.loadGuide();
      } catch {
        // Greet with the injected guide rather than leaving the Caller on silence.
      }
    }
    await this.speak(greetingFor(this.guide));
  }

  receiveAudio(mulaw: Buffer): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.endpointer.receiveAudio(mulaw);
  }

  /** Test seam: wait for queued utterance handlers. */
  async flush(): Promise<void> {
    await this.pending;
  }

  /** Text in, audio out, plus the playback-completion the endpoint timer keys off. */
  async speak(text: string): Promise<void> {
    this.endpointer.suspend();
    try {
      await this.enqueueSpeech(text);
    } finally {
      if (!this.closed) this.endpointer.resume();
    }
  }

  /** Queue speech behind whatever is already playing so holds and replies never overlap. */
  private enqueueSpeech(text: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const run = this.speechTail.then(() => this.emitAudio(text));
    this.speechTail = run.catch(() => {});
    return run;
  }

  /** Synthesize one sentence and emit it; caller owns suspend/resume. */
  private async emitAudio(text: string): Promise<void> {
    const { audio } = await this.tts.synthesize(text);
    if (this.closed) return;
    this.sendAudio(audio);
    this.onPlaybackComplete?.(text);
  }

  /** One spoken sentence with start/done/error timing around the TTS leg. */
  private async speakSentence(text: string, turn: number): Promise<void> {
    const started = Date.now();
    this.logPhase('tts', 'start', { turn, chars: text.length });
    try {
      await this.enqueueSpeech(text);
      this.logPhase('tts', 'done', { turn, ms: Date.now() - started, chars: text.length });
    } catch (err) {
      this.logPhase('tts', 'error', {
        turn,
        ms: Date.now() - started,
        detail: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
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

  /**
   * Speak a holding line if `phase` is still running after `holdAfterMs`.
   * Returns a cancel function; the line lands in the same queue as replies.
   */
  private scheduleHold(phase: string, text: string): () => void {
    if (this.holdAfterMs <= 0) return () => {};
    let settled = false;
    const timer = setTimeout(() => {
      if (settled || this.closed) return;
      settled = true;
      this.logPhase(phase, 'hold', { text });
      void this.enqueueSpeech(text).catch(() => {});
    }, this.holdAfterMs);
    timer.unref?.();
    return () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
    };
  }

  private async resolveAvailability(): Promise<string> {
    const pending = Promise.resolve().then(() =>
      typeof this.availability === 'function' ? this.availability() : (this.availability ?? availabilityPlaceholder()),
    );
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
   * Assistant-facing Availability read: lazy (only when the model asks), one
   * read per Turn, phase-logged so the console shows where the booking leg
   * went and how long it took.
   */
  private loadAvailability(turn: number): Promise<string> {
    if (this.availabilityForTurn?.turn === turn) return this.availabilityForTurn.value;
    const started = Date.now();
    this.logPhase('availability', 'start', { turn });
    const value = this.resolveAvailability()
      .then((block) => {
        this.logPhase('availability', 'done', {
          turn,
          ms: Date.now() - started,
          chars: block.length,
          none: /(^|\n)- none:/.test(block),
        });
        return block;
      })
      .catch((err: unknown) => {
        this.logPhase('availability', 'error', {
          turn,
          ms: Date.now() - started,
          detail: err instanceof Error ? err.message : String(err),
        });
        throw err;
      });
    this.availabilityForTurn = { turn, value };
    return value;
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.scoreTimer);
    this.logSession?.({ callSid: this.identity.callSid, kind: 'session', event: 'close', reason });
    this.endpointer.endSession();
    // Hangup / dropped socket mid-Turn: log the partial Turn so the clinic
    // sees what the Caller said and what little was spoken back.
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

  private async handleUtterance(utterance: Utterance): Promise<void> {
    if (this.closed) return;
    this.onUtteranceLog?.({
      callSid: this.identity.callSid,
      durationMs: utterance.durationMs,
      bytes: utterance.audio.length,
    });
    const state = this.calls.get(this.identity.callSid);
    state.turn += 1;
    const turn = state.turn;
    this.activeTurn = { turn, excerpt: '', replySoFar: '' };
    let text = '';
    const transcribeStarted = Date.now();
    this.logPhase('transcribe', 'start', { turn });
    try {
      const wav = encodeWav(utterance.audio);
      const tx = await this.transcriber.transcribe(wav, 'audio/wav');
      if (this.closed) return;
      this.logPhase('transcribe', 'done', {
        turn,
        ms: Date.now() - transcribeStarted,
        chars: tx.text.length,
        noSpeech: tx.noSpeech,
      });
      if (!tx.text.trim() || tx.noSpeech) {
        await this.miss(tx.text, turn, undefined);
        return;
      }
      text = tx.text;
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
    if (!this.assistant) {
      // Transcribe-only session (tickets 09/10): Turn is complete once the
      // Caller text lands in history; nothing partial to log on hangup.
      this.activeTurn = null;
      return;
    }
    await this.answerTurn(text, turn);
  }

  /**
   * Full live Turn: grounded assistant reply streamed sentence-by-sentence
   * into speech. Suspends endpointing for the whole reply so no barge-in can
   * start a new utterance mid-reply; listening resumes after the last
   * sentence (or after the failure line on downstream errors).
   */
  private async answerTurn(excerpt: string, turn: number): Promise<void> {
    if (this.closed || !this.assistant) return;
    if (this.loadGuide) {
      try {
        this.guide = await this.loadGuide();
      } catch {
        // Answer with the last good guide rather than failing the Turn.
      }
    }
    const assistant = this.assistant;
    const state = this.calls.get(this.identity.callSid);
    if (this.activeTurn) this.activeTurn.excerpt = excerpt;
    // Single-attempt per confirmed intent: even a misbehaving model gets one
    // writer call per Turn; the second proposal is refused without touching
    // the writer, and a throwing writer surfaces once as a Turn failure.
    let bookingAttempted = false;
    const ctx = {
      transcript: excerpt,
      history: [...state.history],
      guide: this.guide,
      getAvailability: () => this.loadAvailability(turn),
      proposeBooking: (slot: ProposedSlot): Promise<BookingOutcome> => {
        if (bookingAttempted) {
          return Promise.resolve({ ok: false, reason: 'booking already attempted once for this turn; the clinic will confirm shortly' });
        }
        bookingAttempted = true;
        if (!this.onProposeBooking) {
          return Promise.resolve({ ok: false, reason: 'booking is not available yet; the clinic will confirm shortly' });
        }
        return this.onProposeBooking({ callSid: this.identity.callSid, turn, excerpt, slot }).catch((err: unknown) => {
          throw new Error(`booking-error: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
        });
      },
    };
    this.endpointer.suspend();
    let fullReply = '';
    let endCall = false;
    try {
      // Receptionist leg: stream the grounded answer, speaking each sentence.
      // Availability is read lazily by the assistant's get_availability tool,
      // so greetings and small talk never touch the booking system.
      const assistantStarted = Date.now();
      this.logPhase('assistant', 'start', { turn });
      const stopAssistantHold = this.scheduleHold('assistant', HOLD_ASSISTANT_LINE);
      const tokens: AsyncIterable<string> = assistant.replyStream
        ? assistant.replyStream(ctx)
        : (async function* fallback(): AsyncGenerator<string> {
            const out = await assistant.reply(ctx);
            endCall = out.endCall;
            yield out.text;
          })();
      let buffered = '';
      let firstToken = true;
      try {
        for await (const token of tokens) {
          if (this.closed) return;
          if (firstToken) {
            firstToken = false;
            stopAssistantHold();
            this.logPhase('assistant', 'first-token', { turn, ms: Date.now() - assistantStarted });
          }
          fullReply += token;
          if (this.activeTurn) this.activeTurn.replySoFar = fullReply;
          buffered += token;
          const cut = extractCompleteSentences(buffered);
          buffered = cut.rest;
          for (const sentence of cut.sentences) {
            try {
              await this.speakSentence(sentence, turn);
            } catch (err) {
              throw new Error(ttsDetail(err), { cause: err });
            }
            if (this.closed) return;
          }
        }
      } finally {
        stopAssistantHold();
      }
      this.logPhase('assistant', 'done', {
        turn,
        ms: Date.now() - assistantStarted,
        chars: fullReply.length,
        endCall,
      });
      const tail = buffered.trim();
      if (tail) {
        try {
          await this.speakSentence(tail, turn);
        } catch (err) {
          throw new Error(ttsDetail(err), { cause: err });
        }
        if (this.closed) return;
      }
    } catch (err) {
      if (this.closed) return;
      const detail =
        err instanceof Error &&
        (err.message.startsWith('tts-error:') ||
          err.message.startsWith('assistant-error:') ||
          err.message.startsWith('availability-error:') ||
          err.message.startsWith('booking-error:'))
          ? err.message
          : `assistant-error: ${err instanceof Error ? err.message : String(err)}`;
      const bookingSide = detail.startsWith('availability-error:') || detail.startsWith('booking-error:');
      const line = bookingSide ? BOOKING_FAILURE_LINE : FAILURE_LINE;
      this.logPhase('turn', 'error', { turn, detail });
      this.logFailure?.({ callSid: this.identity.callSid, turn, reason: 'low-confidence', excerpt, detail });
      try {
        await this.enqueueSpeech(line);
      } catch {
        // TTS itself failed; the log above is the handoff channel.
      }
      this.logTurn?.({ callSid: this.identity.callSid, turn, excerpt, reply: line, endCall: true, miss: false });
      this.activeTurn = null;
      if (!this.closed) this.endpointer.resume();
      this.close('failure');
      return;
    }
    if (!this.closed) this.endpointer.resume();
    if (this.closed) return;
    if (fullReply.trim()) {
      this.calls.pushHistory(this.identity.callSid, { role: 'receptionist', text: fullReply });
    }
    this.logTurn?.({ callSid: this.identity.callSid, turn, excerpt, reply: fullReply, endCall, miss: false });
    this.activeTurn = null;
    if (endCall) this.close('goodbye');
  }

  private async miss(excerpt: string, turn: number, detail: string | undefined): Promise<void> {
    const state = this.calls.get(this.identity.callSid);
    state.misses += 1;
    if (this.activeTurn) this.activeTurn.excerpt = excerpt;
    // Ticket 12: two reprompts, handoff on the third miss. Reprompts log a
    // Turn only; the handoff logs a failure first, then a terminal Turn.
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
        await this.speak(REPROMPT_LINE);
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
      await this.speak(goodbye);
    } catch {
      // Goodbye TTS failed; the failure log above is the handoff channel.
    }
    this.close('goodbye');
  }
}
