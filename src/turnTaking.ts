import { decodeMulaw } from './mulaw.ts';
import { EchoGate, type EchoDecision, type EchoGateOptions } from './echoGate.ts';
import {
  BARGE_IN_DEFAULTS,
  type BargeInEvent,
  type EndpointPolicy,
  type Utterance,
  type Vad,
} from './endpoint.ts';

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
  /** A frame the live STT channel should hear; Echo is replaced with silence, never dropped. */
  onUpstreamFrame?(frame: Buffer): void;
  /** Every frame heard while the Receptionist holds the floor, Echo or Caller. */
  onEchoDecision?(decision: EchoDecision): void;
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
  /** Sustained non-Echo Caller speech that fires a Barge-in while the Receptionist speaks. */
  bargeInMinSpeechMs?: number;
  /** Sub-threshold dip a Barge-in candidate tolerates before resetting. */
  bargeInDipToleranceMs?: number;
  /** Boundary authority for this call. */
  detection: TurnDetection;
  /** Echo-gate tuning; defaults ship the bench-tuned values. */
  echoGate?: EchoGateOptions;
}

type Floor = 'listening' | 'watching-barge-in' | 'idle';

/** A frame of mu-law silence (0xFF decodes to zero). */
function silenceMulaw(length: number): Buffer {
  return Buffer.alloc(length, 0xff);
}

/**
 * Owns one call's turn-taking surface: the upstream audio diet, the Echo
 * gate, the local VAD gate, utterance segmentation, and Barge-in candidate
 * state. The session above it sees only Turns and Barge-ins. Durations derive
 * from sample counts, never wall-clock time, so behavior is deterministic in
 * tests. Calls serialize internally; callers may fire receiveAudio without
 * awaiting.
 */
export class TurnTaking {
  private readonly vad: Vad;
  private readonly policy: EndpointPolicy;
  private readonly observer: TurnTakingObserver;
  private readonly bargeInMinSpeechMs: number;
  private readonly bargeInDipToleranceMs: number;
  private readonly detection: TurnDetection;
  private readonly echoGate: EchoGate;
  private mode: Floor = 'listening';
  private bargeInPending = false;
  private speaking = false;
  /** Provider speech_open state; the utterance under capture in sarvam mode. */
  private providerOpen = false;
  private providerCorroborated = false;
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
    this.bargeInMinSpeechMs = opts.bargeInMinSpeechMs ?? BARGE_IN_DEFAULTS.minSpeechMs;
    this.bargeInDipToleranceMs = opts.bargeInDipToleranceMs ?? BARGE_IN_DEFAULTS.dipToleranceMs;
    this.detection = opts.detection;
    this.echoGate = new EchoGate(opts.echoGate);
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
   * Retain one played outbound frame as the Echo reference. The session feeds
   * this from actual playout, so the gate correlates against what the Caller
   * heard rather than what was generated.
   */
  retainReference(mulaw: Buffer): void {
    this.echoGate.pushReference(mulaw);
  }

  /**
   * The Receptionist takes the floor. Inbound audio keeps streaming upstream
   * (Echo replaced with silence) and sustained non-Echo Caller speech fires
   * `onBargeIn`; Barge-in is always on.
   */
  startSpeaking(): void {
    this.mode = 'watching-barge-in';
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
   * The provider opened an utterance (`vad.speech_start`). While the
   * Receptionist holds the floor it never triggers a Barge-in; it only
   * corroborates a local candidate, which the fire event carries. In
   * listening it opens the utterance capture.
   */
  providerSpeechStart(): void {
    if (this.detection !== 'sarvam') return;
    if (this.mode === 'watching-barge-in') {
      this.providerCorroborated = true;
      return;
    }
    if (this.mode !== 'listening' || this.providerOpen) return;
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
    if (this.mode === 'idle' || mulaw.length === 0) {
      this.observer.onUpstreamFrame?.(mulaw);
      return;
    }
    const pcm = decodeMulaw(mulaw);
    let isEcho = false;
    let silent = false;
    if (this.mode === 'listening') {
      // Listening frames stream as-is and only feed the Echo gate's history;
      // the first frame of the next Receptionist speech then correlates over a
      // full window instead of one noisy 20 ms slice.
      this.observer.onUpstreamFrame?.(mulaw);
      this.echoGate.observe(pcm);
      // The provider owns boundaries in this mode: keep the fallback capture
      // and leave the local VAD to Barge-in watching only.
      if (this.detection === 'sarvam') {
        this.captureProviderFrame(pcm);
        return;
      }
    } else {
      // The Receptionist holds the floor: audio still streams upstream for the
      // whole call, but the gate replaces our own voice returning through the
      // phone with silence so the live STT channel never hears it as a Caller.
      const decision = this.echoGate.classify(pcm);
      this.observer.onEchoDecision?.(decision);
      isEcho = decision.echo;
      // The gate knows a silent frame carries no Caller speech, whatever the
      // VAD says: a returning Echo that has not arrived yet must not count.
      silent = decision.reason === 'silence';
      this.observer.onUpstreamFrame?.(isEcho ? silenceMulaw(mulaw.length) : mulaw);
    }
    if (this.bargeInPending) return;
    const score = await this.vad.score(pcm);
    this.observer.onScore?.(score, this.speaking);
    // Echo and silence are never Caller speech, however speech-like the VAD finds them.
    const isSpeech = !isEcho && !silent && score >= this.policy.threshold;
    // Echo frames keep their timing in the utterance but contribute silence,
    // so a Barge-in Turn never transcribes the Receptionist's own words.
    const frame = isEcho ? new Int16Array(pcm.length) : pcm;
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
          this.pushPreRoll(frame);
          return;
        }
        this.candidateSamples += frame.length;
        this.dipSamples += frame.length;
        this.chunks.push(frame);
        this.bufferedSamples += frame.length;
        // Short VAD dips remain part of the candidate phrase. A dip past
        // the budget means the noise burst is over: drop it all.
        const dipToleranceMs =
          this.mode === 'watching-barge-in' ? this.bargeInDipToleranceMs : this.policy.latchDipMs;
        if (toMs(this.dipSamples) >= dipToleranceMs) {
          this.candidateSamples = 0;
          this.chunks = [];
          this.bufferedSamples = 0;
          this.dipSamples = 0;
        }
        return;
      }
      if (this.candidateSamples === 0) this.adoptPreRoll();
      this.candidateSamples += frame.length;
      this.dipSamples = 0;
      this.chunks.push(frame);
      this.bufferedSamples += frame.length;
      if (this.mode === 'watching-barge-in' && toMs(this.candidateSamples) >= this.bargeInMinSpeechMs) {
        this.fireBargeIn();
        return;
      }
      if (toMs(this.candidateSamples) >= this.policy.minSpeechMs) {
        this.speaking = true;
      }
      return;
    }
    this.chunks.push(frame);
    this.bufferedSamples += frame.length;
    this.trailingSilenceSamples = isSpeech ? 0 : this.trailingSilenceSamples + frame.length;
    if (this.mode === 'watching-barge-in') {
      const speechMs = toMs(this.bufferedSamples - this.trailingSilenceSamples);
      if (speechMs >= this.bargeInMinSpeechMs) {
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
    this.mode = 'idle';
    const utterance = this.speechAudio();
    const stats = this.takeStats();
    this.reset();
    this.observer.onUtterance(utterance, stats);
  }

  private fireBargeIn(): void {
    const audio = this.speechAudio();
    const corroborated = this.providerCorroborated;
    this.reset();
    this.bargeInPending = true;
    this.observer.onBargeIn?.({ ...audio, corroborated });
  }

  private reset(): void {
    this.bargeInPending = false;
    this.speaking = false;
    this.providerOpen = false;
    this.providerCorroborated = false;
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
