import { decodeMulaw } from './mulaw.ts';
import type { BargeInEvent, EndpointPolicy, Utterance, Vad } from './endpoint.ts';

/** 8 kHz mulaw: one sample per byte, so durations derive from sample counts. */
const SAMPLE_RATE = 8000;

function toMs(samples: number): number {
  return (samples / SAMPLE_RATE) * 1000;
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}

/** Speech-probability summary for one emitted utterance, for traces and benches. */
export interface UtteranceSpeechStats {
  frames: number;
  maxScore: number;
  meanScore: number;
}

export interface TurnTakingObserver {
  /** A complete Caller utterance, ready for transcription. */
  onUtterance(utterance: Utterance, stats: UtteranceSpeechStats): void;
  /** The Caller has taken the floor; fires once per utterance after the speech latch. */
  onSpeechStart?(): void;
  /** Sustained Caller speech while the Receptionist holds the floor. */
  onBargeIn?(event: BargeInEvent): void;
  /** A frame the live STT channel should hear; absent while muted. */
  onUpstreamFrame?(frame: Buffer): void;
  /** Raw VAD score + latch state per scored frame, for operator diagnostics. */
  onScore?(score: number, latched: boolean): void;
}

/**
 * Who owns utterance boundaries. `sarvam` delegates them to the speech
 * provider: the local VAD no longer ends Turns and the module only captures
 * the utterance audio between provider boundaries for fallback and fixtures.
 * `hybrid` runs the local detector.
 */
export type TurnDetection = 'sarvam' | 'hybrid';

export interface TurnTakingOptions {
  vad: Vad;
  policy: EndpointPolicy;
  observer: TurnTakingObserver;
  /** Sustained speech before a Barge-in candidate fires while the Receptionist speaks. */
  bargeInMs?: number;
  /** Boundary authority for this call. */
  detection: TurnDetection;
}

type Floor = 'listening' | 'muted' | 'watching-barge-in';

/**
 * Owns one call's turn-taking surface: the frame diet to the live STT channel,
 * the local VAD gate, utterance segmentation, and Barge-in candidate state.
 * The session above it sees only Turns and Barge-ins. Durations derive from
 * sample counts, never wall-clock time, so behavior is deterministic in
 * tests. Calls serialize internally; callers may fire receiveAudio without
 * awaiting.
 */
export class TurnTaking {
  private readonly vad: Vad;
  private readonly policy: EndpointPolicy;
  private readonly observer: TurnTakingObserver;
  private readonly bargeInMs: number;
  private readonly detection: TurnDetection;
  private mode: Floor = 'listening';
  private bargeInPending = false;
  private speaking = false;
  /** Provider speech_open state; the utterance under capture in sarvam mode. */
  private providerOpen = false;
  private speechAnnounced = false;
  private candidateSamples = 0;
  private dipSamples = 0;
  private preRollChunks: Int16Array[] = [];
  private preRollSamples = 0;
  private chunks: Int16Array[] = [];
  private bufferedSamples = 0;
  private trailingSilenceSamples = 0;
  private stats = { frames: 0, max: 0, sum: 0 };
  private tail: Promise<unknown> = Promise.resolve();

  constructor(opts: TurnTakingOptions) {
    this.vad = opts.vad;
    this.policy = opts.policy;
    this.observer = opts.observer;
    this.bargeInMs = opts.bargeInMs ?? 200;
    this.detection = opts.detection;
  }

  /** True while a Caller utterance can end a Turn here. */
  get isListening(): boolean {
    return this.mode === 'listening';
  }

  receiveAudio(mulaw: Buffer): Promise<void> {
    const run = this.tail.then(() => this.process(mulaw));
    this.tail = run.catch(() => {});
    return run;
  }

  /**
   * The Receptionist takes the floor. With `watchForBargeIn`, sustained Caller
   * speech still fires `onBargeIn`; otherwise inbound audio is discarded.
   */
  startSpeaking(options?: { watchForBargeIn?: boolean }): void {
    this.mode = options?.watchForBargeIn ? 'watching-barge-in' : 'muted';
    this.reset();
  }

  /** The Receptionist yields the floor; listening restarts clean. */
  startListening(): void {
    this.mode = 'listening';
    this.reset();
  }

  /** Adopts a Barge-in candidate as the first audio of the new Turn. */
  acceptBargeIn(event: BargeInEvent): void {
    this.mode = 'listening';
    this.reset();
    if (this.detection === 'sarvam') {
      // The provider heard the candidate while the floor was watched, so its
      // boundary closes the utterance; the candidate is its captured start.
      this.providerOpen = true;
    } else {
      this.speaking = true;
    }
    this.chunks = [event.audio];
    this.bufferedSamples = event.audio.length;
  }

  /** Drops any partial utterance and releases the VAD. */
  close(): void {
    this.reset();
    this.vad.reset();
  }

  /**
   * The provider opened an utterance (`vad.speech_start`). Audio since the
   * pre-roll is the utterance's first word, so it is captured, not clipped.
   */
  providerSpeechStart(): void {
    if (this.detection !== 'sarvam' || this.mode !== 'listening' || this.providerOpen) return;
    this.providerOpen = true;
    this.adoptPreRoll();
    this.announceSpeechStart();
  }

  /** The provider closed the utterance (`vad.speech_end`): emit it for a Turn. */
  providerSpeechEnd(): void {
    if (this.detection !== 'sarvam' || this.mode !== 'listening' || !this.providerOpen) return;
    this.providerOpen = false;
    this.emit();
  }

  private async process(mulaw: Buffer): Promise<void> {
    if (this.mode === 'muted') return;
    this.observer.onUpstreamFrame?.(mulaw);
    if (this.bargeInPending || mulaw.length === 0) return;
    const pcm = decodeMulaw(mulaw);
    // The provider owns boundaries in this mode: keep the fallback capture
    // and leave the local VAD to Barge-in watching only.
    if (this.detection === 'sarvam' && this.mode === 'listening') {
      this.captureProviderFrame(pcm);
      return;
    }
    const score = await this.vad.score(pcm);
    this.observer.onScore?.(score, this.speaking);
    const isSpeech = score >= this.policy.threshold;
    if (this.speaking) {
      this.announceSpeechStart();
      if (isSpeech) {
        this.stats.frames += 1;
        if (score > this.stats.max) this.stats.max = score;
        this.stats.sum += score;
      }
    }
    if (!this.speaking) {
      if (!isSpeech) {
        if (this.candidateSamples === 0) {
          this.pushPreRoll(pcm);
          return;
        }
        this.candidateSamples += pcm.length;
        this.dipSamples += pcm.length;
        this.chunks.push(pcm);
        this.bufferedSamples += pcm.length;
        // Short VAD dips remain part of the candidate phrase. A dip past
        // the budget means the noise burst is over: drop it all.
        if (toMs(this.dipSamples) >= this.policy.latchDipMs) {
          this.candidateSamples = 0;
          this.chunks = [];
          this.bufferedSamples = 0;
          this.dipSamples = 0;
        }
        return;
      }
      if (this.candidateSamples === 0) this.adoptPreRoll();
      this.candidateSamples += pcm.length;
      this.dipSamples = 0;
      this.chunks.push(pcm);
      this.bufferedSamples += pcm.length;
      if (this.mode === 'watching-barge-in' && toMs(this.candidateSamples) >= this.bargeInMs) {
        this.fireBargeIn();
        return;
      }
      if (toMs(this.candidateSamples) >= this.policy.minSpeechMs) {
        this.speaking = true;
      }
      return;
    }
    this.chunks.push(pcm);
    this.bufferedSamples += pcm.length;
    this.trailingSilenceSamples = isSpeech ? 0 : this.trailingSilenceSamples + pcm.length;
    if (this.mode === 'watching-barge-in') {
      const speechMs = toMs(this.bufferedSamples - this.trailingSilenceSamples);
      if (speechMs >= this.bargeInMs) {
        this.fireBargeIn();
      } else if (toMs(this.trailingSilenceSamples) >= this.policy.silenceMs) {
        this.reset();
      }
      return;
    }
    const trailingMs = toMs(this.trailingSilenceSamples);
    if (trailingMs >= this.policy.silenceMs || this.bufferedMs() >= this.policy.maxUtteranceMs) {
      this.emit();
    }
  }

  private bufferedMs(): number {
    return toMs(this.bufferedSamples);
  }

  private announceSpeechStart(): void {
    if (this.speechAnnounced) return;
    this.speechAnnounced = true;
    this.observer.onSpeechStart?.();
  }

  private takeStats(): UtteranceSpeechStats {
    const { frames, max, sum } = this.stats;
    this.stats = { frames: 0, max: 0, sum: 0 };
    return {
      frames,
      maxScore: round3(max),
      meanScore: frames > 0 ? round3(sum / frames) : 0,
    };
  }

  /** Buffer provider-boundary audio for the REST fallback and fixture capture. */
  private captureProviderFrame(pcm: Int16Array): void {
    if (!this.providerOpen) {
      this.pushPreRoll(pcm);
      return;
    }
    this.chunks.push(pcm);
    this.bufferedSamples += pcm.length;
  }

  /** Seed the utterance buffer with the recent pre-roll so its first word survives. */
  private adoptPreRoll(): void {
    this.chunks = this.preRollChunks;
    this.bufferedSamples = this.preRollSamples;
    this.preRollChunks = [];
    this.preRollSamples = 0;
  }

  private pushPreRoll(pcm: Int16Array): void {
    this.preRollChunks.push(pcm);
    this.preRollSamples += pcm.length;
    const maxSamples = Math.round((this.policy.minSpeechMs / 1000) * SAMPLE_RATE);
    while (this.preRollSamples > maxSamples) {
      const first = this.preRollChunks[0]!;
      const excess = this.preRollSamples - maxSamples;
      if (first.length <= excess) {
        this.preRollChunks.shift();
        this.preRollSamples -= first.length;
      } else {
        this.preRollChunks[0] = first.subarray(excess);
        this.preRollSamples -= excess;
      }
    }
  }

  private speechAudio(): Utterance {
    const speechSamples = this.bufferedSamples - this.trailingSilenceSamples;
    const audio = new Int16Array(speechSamples);
    let offset = 0;
    let remaining = speechSamples;
    for (const c of this.chunks) {
      if (remaining <= 0) break;
      const take = Math.min(c.length, remaining);
      audio.set(c.subarray(0, take), offset);
      offset += take;
      remaining -= take;
    }
    return { audio, durationMs: Math.round(toMs(speechSamples)) };
  }

  private emit(): void {
    this.mode = 'muted';
    const utterance = this.speechAudio();
    const stats = this.takeStats();
    this.reset();
    this.observer.onUtterance(utterance, stats);
  }

  private fireBargeIn(): void {
    const event = this.speechAudio();
    this.reset();
    this.bargeInPending = true;
    this.observer.onBargeIn?.(event);
  }

  private reset(): void {
    this.bargeInPending = false;
    this.speaking = false;
    this.providerOpen = false;
    this.speechAnnounced = false;
    this.candidateSamples = 0;
    this.dipSamples = 0;
    this.preRollChunks = [];
    this.preRollSamples = 0;
    this.chunks = [];
    this.bufferedSamples = 0;
    this.trailingSilenceSamples = 0;
  }
}
