/** Speech-probability scorer for one PCM chunk. Implementations must be stateful-safe per call. */
export interface Vad {
  score(pcm: Int16Array): Promise<number>;
  reset(): void;
}

/**
 * Local detector fallbacks for the knobs that left the env surface: the
 * Barge-in candidate knobs are separate, and `silenceMs` backs the Barge-in
 * candidate reset while the adaptive pause owns the local Turn boundary.
 */
export const LOCAL_ENDPOINT_FALLBACKS = {
  silenceMs: 1000,
  minSpeechMs: 300,
  maxUtteranceMs: 30_000,
  latchDipMs: 200,
} as const;

/**
 * Shipped Barge-in candidate defaults: sustained non-Echo speech, dip
 * tolerance, the wait for partial semantics that confirms a Backchannel
 * rather than a content-bearing interruption, and the extra lag allowance
 * past that wait for live partials that trail energy.
 */
export const BARGE_IN_DEFAULTS = { minSpeechMs: 200, dipToleranceMs: 200, confirmMs: 300, lagMs: 300 } as const;

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
  /**
   * Locally-heard silence that preceded this boundary, in ms. The Caller's
   * last speech sample is roughly the endpoint minus this.
   */
  trailingSilenceMs?: number;
}

export interface BargeInEvent {
  audio: Int16Array;
  durationMs: number;
}

/** A short acknowledgement absorbed while the Receptionist held the floor. */
export interface BackchannelEvent {
  durationMs: number;
  /** Partial transcript that identified it as a Backchannel. */
  text: string;
}
