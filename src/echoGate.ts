import { decodeMulaw } from './mulaw.ts';
import { LIVE_SAMPLE_RATE } from './audio.ts';

/** Why the gate decided the way it did; every reason is trace evidence. */
export type EchoReason = 'echo' | 'silence' | 'no-reference' | 'uncorrelated' | 'double-talk';

/**
 * What the gate saw when it classified one inbound frame. Values are the
 * decision inputs, kept for traces and benches, never for behaviour.
 */
export interface EchoEvidence {
  /** Normalized cross-correlation at the winning delay, 0..1. */
  correlation: number;
  /** Winning delay of the returned reference, in milliseconds. */
  delayMs: number;
  /** RMS of the reference window the winner matched. */
  referenceRms: number;
  /** RMS of the inbound frame. */
  inboundRms: number;
  /** Inbound RMS after subtracting the predicted Echo; null until a level is learned. */
  residualRms: number | null;
  /** Learned echo-return loss in dB (negative); null until a level is learned. */
  returnLossDb: number | null;
  /** Correlation needed to call a frame Echo. */
  threshold: number;
  /** How much louder than the learned return counts as Caller double-talk. */
  marginDb: number;
}

export interface EchoDecision {
  echo: boolean;
  reason: EchoReason;
  evidence: EchoEvidence;
}

export interface EchoGateOptions {
  sampleRate?: number;
  /** Longest Echo return the delay search considers. */
  maxDelayMs?: number;
  /** Normalized correlation needed to call a frame Echo. */
  correlationThreshold?: number;
  /** dB above the learned return that counts as Caller energy over Echo. */
  levelMarginDb?: number;
}

/** Correlation trusted enough to learn the return level and delay from. */
const LEARN_CORRELATION = 0.85;
/** Inbound RMS below this is silence, whatever the reference is doing. */
const SILENCE_FLOOR_RMS = 40;
/** Reference RMS below this is too quiet to explain inbound energy. */
const REFERENCE_FLOOR_RMS = 60;
/** EMA weight for the learned return level, per Echo frame. */
const LEARNING_RATE = 0.25;

const DEFAULTS = {
  sampleRate: LIVE_SAMPLE_RATE,
  maxDelayMs: 600,
  correlationThreshold: 0.7,
  levelMarginDb: 6,
} as const;

const REFERENCE_WINDOW_MS = 2000;
/** Previous inbound audio folded into every correlation, so one frame's noise cannot decide. */
const TAIL_SAMPLES = 160;
const COARSE_STEP_SAMPLES = 20;
const SEARCH_RADIUS_SAMPLES = 240;

/** RMS of a PCM window; the shared energy primitive for the gate and its benches. */
export function rms(pcm: ArrayLike<number>): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i]! * pcm[i]!;
  return Math.sqrt(sum / pcm.length);
}

/** Pearson correlation, 0 when either side has no variance. */
function correlation(x: ArrayLike<number>, y: ArrayLike<number>, length: number): number {
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < length; i++) {
    sumX += x[i]!;
    sumY += y[i]!;
  }
  const meanX = sumX / length;
  const meanY = sumY / length;
  let dot = 0;
  let energyX = 0;
  let energyY = 0;
  for (let i = 0; i < length; i++) {
    const dx = x[i]! - meanX;
    const dy = y[i]! - meanY;
    dot += dx * dy;
    energyX += dx * dx;
    energyY += dy * dy;
  }
  if (energyX <= 0 || energyY <= 0) return 0;
  return dot / Math.sqrt(energyX * energyY);
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}

interface Match {
  correlation: number;
  delaySamples: number;
  referenceRms: number;
  inboundRms: number;
}

/**
 * Per-call Echo gate: retains the Receptionist's played audio as a reference
 * and classifies each inbound frame as its own voice returning (Echo) or not.
 * The decision combines a normalized cross-correlation against the reference
 * at an adaptive delay with the learned echo-return level: a correlated frame
 * at the learned level is Echo, a correlated frame far louder than the return
 * is the Caller talking over it (double-talk), and an uncorrelated frame is
 * the Caller. Classification is passive: nothing here stops audio or ends a
 * Turn.
 */
export class EchoGate {
  private readonly sampleRate: number;
  private readonly maxDelaySamples: number;
  private readonly correlationThreshold: number;
  private readonly levelMarginDb: number;
  private readonly ring: Float32Array;
  private readonly tail: Float32Array = new Float32Array(TAIL_SAMPLES);
  private tailLength = 0;
  private window: Float32Array = new Float32Array(TAIL_SAMPLES);
  private readonly segment: Float32Array;
  private writeIndex = 0;
  private written = 0;
  private delaySamples: number | null = null;
  private weakFrames = 0;
  private lossDb: number | null = null;

  constructor(opts: EchoGateOptions = {}) {
    this.sampleRate = opts.sampleRate ?? DEFAULTS.sampleRate;
    this.maxDelaySamples = Math.round(((opts.maxDelayMs ?? DEFAULTS.maxDelayMs) / 1000) * this.sampleRate);
    this.correlationThreshold = opts.correlationThreshold ?? DEFAULTS.correlationThreshold;
    this.levelMarginDb = opts.levelMarginDb ?? DEFAULTS.levelMarginDb;
    this.ring = new Float32Array(Math.round((REFERENCE_WINDOW_MS / 1000) * this.sampleRate));
    this.segment = new Float32Array(this.maxDelaySamples + TAIL_SAMPLES);
  }

  /** Learned echo-return loss in dB (negative), or null before an Echo is seen. */
  get returnLossDb(): number | null {
    return this.lossDb;
  }

  /** Retain played outbound audio as the Echo reference. */
  pushReference(mulaw: Buffer): void {
    const pcm = decodeMulaw(mulaw);
    for (let i = 0; i < pcm.length; i++) {
      this.ring[this.writeIndex] = pcm[i]!;
      this.writeIndex = (this.writeIndex + 1) % this.ring.length;
    }
    this.written += pcm.length;
  }

  /**
   * Fold an inbound frame into the correlation history without deciding on
   * it. The session observes every frame it hears, so the first frame of the
   * Receptionist's speech already correlates over a full window.
   */
  observe(pcm: Int16Array): void {
    this.pushTail(pcm);
  }

  /** Classify one inbound Caller-audio frame. Never mutates frame audio. */
  classify(pcm: Int16Array): EchoDecision {
    const inboundRms = rms(pcm);
    const evidence = (
      echo: boolean,
      reason: EchoReason,
      correlationValue = 0,
      delaySamples = 0,
      referenceRms = 0,
      residualRms: number | null = null,
    ): EchoDecision => ({
      echo,
      reason,
      evidence: {
        correlation: round3(correlationValue),
        delayMs: round3((delaySamples / this.sampleRate) * 1000),
        referenceRms: round3(referenceRms),
        inboundRms: round3(inboundRms),
        residualRms: residualRms === null ? null : round3(residualRms),
        returnLossDb: this.lossDb === null ? null : round3(this.lossDb),
        threshold: this.correlationThreshold,
        marginDb: this.levelMarginDb,
      },
    });
    if (pcm.length === 0 || inboundRms < SILENCE_FLOOR_RMS) {
      this.pushTail(pcm);
      return evidence(false, 'silence');
    }
    const window = this.correlationWindow(pcm);
    // The full window is steadier; when it is diluted (the tail is silence as
    // an Echo burst begins), an almost-perfect match on the current frame
    // alone still counts, at the learn-grade bar.
    let chosen: ArrayLike<number> = window;
    let best = this.searchDelay(window);
    if ((best === null || best.correlation < this.correlationThreshold) && window.length > pcm.length) {
      const half = this.searchDelay(pcm);
      if (
        half !== null &&
        half.correlation >= LEARN_CORRELATION &&
        (best === null || half.correlation > best.correlation)
      ) {
        best = half;
        chosen = pcm;
      }
    }
    this.pushTail(pcm);
    if (best === null) {
      this.noteWeak();
      return evidence(false, 'no-reference', 0, 0, 0);
    }
    if (best.correlation < this.correlationThreshold) {
      this.noteWeak();
      return evidence(false, 'uncorrelated', best.correlation, best.delaySamples, best.referenceRms);
    }
    this.weakFrames = 0;
    const measuredLossDb = 20 * Math.log10(best.inboundRms / best.referenceRms);
    // A near-perfect match is Echo even when the level moved: a changed
    // acoustic path (earpiece to speakerphone) looks exactly like this, and
    // the level is re-learned rather than locking the gate out forever.
    if (best.correlation < LEARN_CORRELATION && this.lossDb !== null && measuredLossDb > this.lossDb + this.levelMarginDb) {
      return evidence(
        false,
        'double-talk',
        best.correlation,
        best.delaySamples,
        best.referenceRms,
        this.residualRms(chosen, best.delaySamples),
      );
    }
    this.learn(best.delaySamples, measuredLossDb);
    return evidence(
      true,
      'echo',
      best.correlation,
      best.delaySamples,
      best.referenceRms,
      this.residualRms(chosen, best.delaySamples),
    );
  }

  /**
   * The correlation input: the previous inbound frame plus this one, so a
   * single noisy 20 ms window cannot carry the decision alone.
   */
  private correlationWindow(pcm: Int16Array): Float32Array {
    const length = this.tailLength + pcm.length;
    if (this.window.length < length) this.window = new Float32Array(length);
    this.window.set(this.tail.subarray(0, this.tailLength), 0);
    this.window.set(pcm, this.tailLength);
    return this.window.subarray(0, length);
  }

  /** Roll the current frame into the tail used by the next correlation. */
  private pushTail(pcm: Int16Array): void {
    if (pcm.length === 0) return;
    if (pcm.length >= TAIL_SAMPLES) {
      this.tail.set(pcm.subarray(pcm.length - TAIL_SAMPLES));
      this.tailLength = TAIL_SAMPLES;
      return;
    }
    const keep = Math.min(this.tailLength, TAIL_SAMPLES - pcm.length);
    if (keep > 0) this.tail.copyWithin(0, this.tailLength - keep, this.tailLength);
    this.tail.set(pcm, keep);
    this.tailLength = keep + pcm.length;
  }

  /**
   * Best delay/attenuation match for this window. Locked to a delay, the
   * search only tracks jitter around it; unlocked, it scans the whole return
   * window coarsely then refines, so the first Echo locks the delay.
   */
  private searchDelay(window: ArrayLike<number>): Match | null {
    if (this.written < window.length) return null;
    const candidates: number[] = [];
    if (this.delaySamples !== null) {
      const from = Math.max(0, this.delaySamples - SEARCH_RADIUS_SAMPLES);
      const to = Math.min(this.maxDelaySamples, this.delaySamples + SEARCH_RADIUS_SAMPLES);
      for (let d = from; d <= to; d += 2) candidates.push(d);
    } else {
      for (let d = 0; d <= this.maxDelaySamples; d += COARSE_STEP_SAMPLES) candidates.push(d);
      const coarse = this.bestCandidate(window, candidates);
      if (coarse === null) return null;
      candidates.length = 0;
      const from = Math.max(0, coarse.delaySamples - COARSE_STEP_SAMPLES);
      const to = Math.min(this.maxDelaySamples, coarse.delaySamples + COARSE_STEP_SAMPLES);
      for (let d = from; d <= to; d += 1) candidates.push(d);
    }
    return this.bestCandidate(window, candidates);
  }

  private bestCandidate(window: ArrayLike<number>, candidates: number[]): Match | null {
    const inboundRms = rms(window);
    let best: Match | null = null;
    for (const delaySamples of candidates) {
      const segment = this.referenceWindow(delaySamples, window.length);
      if (segment === null) continue;
      const referenceRms = rms(segment);
      if (referenceRms < REFERENCE_FLOOR_RMS) continue;
      const value = correlation(window, segment, window.length);
      if (best === null || value > best.correlation) best = { correlation: value, delaySamples, referenceRms, inboundRms };
    }
    return best;
  }

  /** The `length` reference samples ending `delaySamples` before now, or null. */
  private referenceWindow(delaySamples: number, length: number): Float32Array | null {
    const end = this.written - delaySamples;
    const start = end - length;
    if (start < 0 || end > this.written) return null;
    const segment = length <= this.segment.length ? this.segment.subarray(0, length) : new Float32Array(length);
    for (let i = 0; i < length; i++) {
      segment[i] = this.ring[(start + i) % this.ring.length]!;
    }
    return segment;
  }

  private residualRms(window: ArrayLike<number>, delaySamples: number): number {
    if (this.lossDb === null) return rms(window);
    const gain = 10 ** (this.lossDb / 20);
    const segment = this.referenceWindow(delaySamples, window.length);
    if (segment === null) return rms(window);
    let sum = 0;
    for (let i = 0; i < window.length; i++) {
      const residual = window[i]! - segment[i]! * gain;
      sum += residual * residual;
    }
    return Math.sqrt(sum / window.length);
  }

  /**
   * A locked delay loses its lock after a short run of weak matches, so a
   * changed return path (phone switched ear, speakerphone on) is re-found by
   * a full scan instead of being tracked forever at the stale delay.
   */
  private noteWeak(): void {
    if (this.delaySamples === null) return;
    this.weakFrames += 1;
    if (this.weakFrames < 3) return;
    this.delaySamples = null;
    this.weakFrames = 0;
  }

  /** Learn the return level and delay from a match strong enough to trust. */
  private learn(delaySamples: number, measuredLossDb: number): void {
    this.delaySamples = delaySamples;
    if (this.lossDb === null) {
      this.lossDb = measuredLossDb;
      return;
    }
    this.lossDb += (measuredLossDb - this.lossDb) * LEARNING_RATE;
  }
}
