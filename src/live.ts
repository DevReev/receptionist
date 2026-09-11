import {
  availabilityPlaceholder,
  FAILURE_LINE,
  greetingFor,
  goodbyeFor,
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
  /** Single-attempt booking proposal, same seam as the legacy loop. */
  onProposeBooking?: (args: LiveProposeBookingArgs) => Promise<BookingOutcome>;
  calls: CallStore;
  logTurn?: (event: TurnEvent) => void;
  logFailure?: (event: FailureEvent) => void;
  onUtteranceLog?: (entry: { callSid: string; durationMs: number; bytes: number }) => void;
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
 * transcriber seam, misses counted toward the bounded-reprompt policy.
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
  private readonly onProposeBooking:
    | ((args: LiveProposeBookingArgs) => Promise<BookingOutcome>)
    | undefined;
  private readonly calls: CallStore;
  private readonly logTurn?: (event: TurnEvent) => void;
  private readonly logFailure?: (event: FailureEvent) => void;
  private readonly onUtteranceLog?: (entry: { callSid: string; durationMs: number; bytes: number }) => void;
  private readonly onPlaybackComplete?: (text: string) => void;
  private readonly onCloseCb?: (reason: string) => void;
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
  private greeted = false;

  constructor(opts: LiveCallOptions) {
    this.identity = opts.identity;
    this.sendAudio = opts.sendAudio;
    this.transcriber = opts.transcriber;
    this.tts = opts.tts;
    this.guide = opts.guide;
    this.loadGuide = opts.loadGuide;
    this.assistant = opts.assistant;
    this.availability = opts.availability;
    this.onProposeBooking = opts.onProposeBooking;
    this.calls = opts.calls;
    this.logTurn = opts.logTurn;
    this.logFailure = opts.logFailure;
    this.onUtteranceLog = opts.onUtteranceLog;
    this.onPlaybackComplete = opts.onPlaybackComplete;
    this.onCloseCb = opts.onClose;
    this.endpointer = new Endpointer(opts.vad, opts.policy, {
      onUtterance: (utterance) => {
        this.pending = this.pending.then(() => this.handleUtterance(utterance)).catch(() => {});
      },
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Session open: greet through the session's own TTS path (one voice). */
  async open(): Promise<void> {
    if (this.closed || this.greeted) return;
    this.greeted = true;
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
      await this.emitAudio(text);
    } finally {
      if (!this.closed) this.endpointer.resume();
    }
  }

  /** Synthesize one sentence and emit it; caller owns suspend/resume. */
  private async emitAudio(text: string): Promise<void> {
    const { audio } = await this.tts.synthesize(text);
    if (this.closed) return;
    this.sendAudio(audio);
    this.onPlaybackComplete?.(text);
  }

  private async resolveAvailability(): Promise<string> {
    if (typeof this.availability === 'function') return this.availability();
    return this.availability ?? availabilityPlaceholder();
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.endpointer.endSession();
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
    let text = '';
    try {
      const wav = encodeWav(utterance.audio);
      const tx = await this.transcriber.transcribe(wav, 'audio/wav');
      if (this.closed) return;
      if (!tx.text.trim() || tx.noSpeech) {
        await this.miss(tx.text, turn, undefined);
        return;
      }
      text = tx.text;
    } catch (err) {
      if (this.closed) return;
      const detail = err instanceof Error ? `transcribe-error: ${err.message}` : `transcribe-error: ${String(err)}`;
      await this.miss(text, turn, detail);
      return;
    }
    state.misses = 0;
    this.calls.pushHistory(this.identity.callSid, { role: 'caller', text });
    if (!this.assistant) return;
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
    const availability = await this.resolveAvailability();
    const state = this.calls.get(this.identity.callSid);
    const ctx = {
      transcript: excerpt,
      history: [...state.history],
      guide: this.guide,
      availability,
      proposeBooking: (slot: ProposedSlot): Promise<BookingOutcome> => {
        if (!this.onProposeBooking) {
          return Promise.resolve({ ok: false, reason: 'booking is not available yet; the clinic will confirm shortly' });
        }
        return this.onProposeBooking({ callSid: this.identity.callSid, turn, excerpt, slot });
      },
    };
    this.endpointer.suspend();
    let fullReply = '';
    let endCall = false;
    try {
      const tokens: AsyncIterable<string> = assistant.replyStream
        ? assistant.replyStream(ctx)
        : (async function* fallback(): AsyncGenerator<string> {
            const out = await assistant.reply(ctx);
            endCall = out.endCall;
            yield out.text;
          })();
      let buffered = '';
      for await (const token of tokens) {
        if (this.closed) return;
        fullReply += token;
        buffered += token;
        const cut = extractCompleteSentences(buffered);
        buffered = cut.rest;
        for (const sentence of cut.sentences) {
          try {
            await this.emitAudio(sentence);
          } catch (err) {
            throw new Error(ttsDetail(err), { cause: err });
          }
          if (this.closed) return;
        }
      }
      const tail = buffered.trim();
      if (tail) {
        try {
          await this.emitAudio(tail);
        } catch (err) {
          throw new Error(ttsDetail(err), { cause: err });
        }
        if (this.closed) return;
      }
    } catch (err) {
      if (this.closed) return;
      const detail =
        err instanceof Error && (err.message.startsWith('tts-error:') || err.message.startsWith('assistant-error:'))
          ? err.message
          : `assistant-error: ${err instanceof Error ? err.message : String(err)}`;
      this.logFailure?.({ callSid: this.identity.callSid, turn, reason: 'low-confidence', excerpt, detail });
      try {
        await this.emitAudio(FAILURE_LINE);
      } catch {
        // TTS itself failed; the log above is the handoff channel.
      }
      this.logTurn?.({ callSid: this.identity.callSid, turn, excerpt, reply: FAILURE_LINE, endCall: true, miss: false });
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
    if (endCall) this.close('goodbye');
  }

  private async miss(excerpt: string, turn: number, detail: string | undefined): Promise<void> {
    const state = this.calls.get(this.identity.callSid);
    state.misses += 1;
    if (state.misses <= 1) {
      this.logTurn?.({
        callSid: this.identity.callSid,
        turn,
        excerpt,
        reply: REPROMPT_LINE,
        endCall: false,
        miss: true,
      });
      await this.speak(REPROMPT_LINE);
      return;
    }
    this.logFailure?.({ callSid: this.identity.callSid, turn, reason: 'low-confidence', excerpt, detail });
    const goodbye = goodbyeFor(this.guide);
    this.logTurn?.({ callSid: this.identity.callSid, turn, excerpt, reply: goodbye, endCall: true, miss: true });
    await this.speak(goodbye);
    this.close('goodbye');
  }
}
