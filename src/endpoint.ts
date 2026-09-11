import { decodeMulaw } from './mulaw.ts';

export const ENDPOINT_SAMPLE_RATE = 8000;

function toMs(samples: number): number {
  return (samples / ENDPOINT_SAMPLE_RATE) * 1000;
}

/** Speech-probability scorer for one PCM chunk. Implementations must be stateful-safe per call. */
export interface Vad {
  score(pcm: Int16Array): Promise<number>;
  reset(): void;
}

export interface EndpointPolicy {
  silenceMs: number;
  minSpeechMs: number;
  maxUtteranceMs: number;
  threshold: number;
  /**
   * Pre-latch dip tolerance: brief sub-threshold flicker while gathering
   * speech does not reset the latch; a longer dip does. Real VAD output
   * flickers at speech boundaries — strict consecutiveness never latches
   * on it (max observed run 160 ms against a 300 ms latch).
   */
  latchDipMs: number;
}

export interface Utterance {
  audio: Int16Array;
  durationMs: number;
}

export interface EndpointObserver {
  onUtterance(utterance: Utterance): void;
  /** Per-frame raw VAD score + latch state, for operator diagnostics. */
  onScore?(score: number, latched: boolean): void;
}

/**
 * Turns a scored audio stream into utterance events. Durations derive from
 * sample counts, never wall-clock time, so behavior is deterministic in tests.
 * Calls serialize internally; callers may fire receiveAudio without awaiting.
 */
export class Endpointer {
  private readonly vad: Vad;
  private readonly policy: EndpointPolicy;
  private readonly observer: EndpointObserver;
  private suspended = false;
  private speaking = false;
  private candidateSamples = 0;
  private dipSamples = 0;
  private preRollChunks: Int16Array[] = [];
  private preRollSamples = 0;
  private chunks: Int16Array[] = [];
  private bufferedSamples = 0;
  private trailingSilenceSamples = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(vad: Vad, policy: EndpointPolicy, observer: EndpointObserver) {
    this.vad = vad;
    this.policy = policy;
    this.observer = observer;
  }

  receiveAudio(mulaw: Buffer): Promise<void> {
    const run = this.tail.then(() => this.process(mulaw));
    this.tail = run.catch(() => {});
    return run;
  }

  /** Discards inbound audio (no barge-in); drops any partial utterance. */
  suspend(): void {
    this.suspended = true;
    this.reset();
  }

  /** Listening resumes clean; the endpoint timer restarts from here. */
  resume(): void {
    this.suspended = false;
    this.reset();
  }

  /** Drops any partial utterance without emitting. */
  endSession(): void {
    this.reset();
    this.vad.reset();
  }

  private async process(mulaw: Buffer): Promise<void> {
    if (this.suspended || mulaw.length === 0) return;
    const pcm = decodeMulaw(mulaw);
    const score = await this.vad.score(pcm);
    this.observer.onScore?.(score, this.speaking);
    const isSpeech = score >= this.policy.threshold;
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
      if (this.candidateSamples === 0) {
        this.chunks = this.preRollChunks;
        this.bufferedSamples = this.preRollSamples;
        this.preRollChunks = [];
        this.preRollSamples = 0;
      }
      this.candidateSamples += pcm.length;
      this.dipSamples = 0;
      this.chunks.push(pcm);
      this.bufferedSamples += pcm.length;
      if (toMs(this.candidateSamples) >= this.policy.minSpeechMs) this.speaking = true;
      return;
    }
    this.chunks.push(pcm);
    this.bufferedSamples += pcm.length;
    this.trailingSilenceSamples = isSpeech ? 0 : this.trailingSilenceSamples + pcm.length;
    const trailingMs = toMs(this.trailingSilenceSamples);
    if (trailingMs >= this.policy.silenceMs || this.bufferedMs() >= this.policy.maxUtteranceMs) {
      this.emit();
    }
  }

  private bufferedMs(): number {
    return toMs(this.bufferedSamples);
  }

  private pushPreRoll(pcm: Int16Array): void {
    this.preRollChunks.push(pcm);
    this.preRollSamples += pcm.length;
    const maxSamples = Math.round((this.policy.minSpeechMs / 1000) * ENDPOINT_SAMPLE_RATE);
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

  private emit(): void {
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
    const durationMs = Math.round(toMs(speechSamples));
    this.reset();
    this.observer.onUtterance({ audio, durationMs });
  }

  private reset(): void {
    this.speaking = false;
    this.candidateSamples = 0;
    this.dipSamples = 0;
    this.preRollChunks = [];
    this.preRollSamples = 0;
    this.chunks = [];
    this.bufferedSamples = 0;
    this.trailingSilenceSamples = 0;
  }
}
