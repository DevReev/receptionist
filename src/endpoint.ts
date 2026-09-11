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
  private speechMs = 0;
  private dipSamples = 0;
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
    const isSpeech = (await this.vad.score(pcm)) >= this.policy.threshold;
    const ms = toMs(pcm.length);
    if (!this.speaking) {
      if (!isSpeech) {
        this.dipSamples += pcm.length;
        // A short dip is VAD flicker — keep gathering. A dip past the
        // budget means the noise burst is over: drop it all.
        if (toMs(this.dipSamples) >= this.policy.latchDipMs) {
          this.chunks = [];
          this.bufferedSamples = 0;
          this.speechMs = 0;
          this.dipSamples = 0;
        }
        return;
      }
      this.speechMs += ms;
      this.dipSamples = 0;
      this.chunks.push(pcm);
      this.bufferedSamples += pcm.length;
      if (this.speechMs >= this.policy.minSpeechMs) this.speaking = true;
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
    this.speechMs = 0;
    this.dipSamples = 0;
    this.chunks = [];
    this.bufferedSamples = 0;
    this.trailingSilenceSamples = 0;
  }
}
