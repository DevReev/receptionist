import { greetingFor, goodbyeFor, REPROMPT_LINE, type Transcriber } from './app.ts';
import { encodeWav } from './audio.ts';
import type { CallStore } from './calls.ts';
import type { ClinicGuide } from './clinic.ts';
import { Endpointer, type EndpointPolicy, type Utterance, type Vad } from './endpoint.ts';
import type { StreamIdentity } from './stream.ts';
import type { Tts } from './tts.ts';
import type { FailureEvent, TurnEvent } from './app.ts';

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
  calls: CallStore;
  logTurn?: (event: TurnEvent) => void;
  logFailure?: (event: FailureEvent) => void;
  onUtteranceLog?: (entry: { callSid: string; durationMs: number; bytes: number }) => void;
  /** Playback-completion signal the Endpointing timer keys off. */
  onPlaybackComplete?: (text: string) => void;
  onClose?: (reason: string) => void;
}

/**
 * One call's live loop slice for tickets 09+10: greeting spoken in-session
 * through TTS, endpointed utterances transcribed through the unchanged
 * transcriber seam, misses counted toward the bounded-reprompt policy.
 * The assistant reply leg arrives with ticket 11.
 */
export class LiveCallSession {
  private readonly identity: StreamIdentity;
  private readonly sendAudio: (audio: Buffer) => void;
  private readonly endpointer: Endpointer;
  private readonly transcriber: Transcriber;
  private readonly tts: Tts;
  private guide: ClinicGuide;
  private readonly loadGuide: (() => Promise<ClinicGuide>) | undefined;
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
      const { audio } = await this.tts.synthesize(text);
      if (this.closed) return;
      this.sendAudio(audio);
      this.onPlaybackComplete?.(text);
    } finally {
      if (!this.closed) this.endpointer.resume();
    }
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
