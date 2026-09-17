/** Speech-probability scorer for one PCM chunk. Implementations must be stateful-safe per call. */
export interface Vad {
  score(pcm: Int16Array): Promise<number>;
  reset(): void;
}

/**
 * Local (hybrid) detector fallbacks for the knobs that left the env surface:
 * the provider owns primary boundaries, and the Barge-in candidate knobs are
 * separate. Silence keeps the last shipped value (`.env`, 1000 ms) until the
 * adaptive pause lands (ticket 07).
 */
export const LOCAL_ENDPOINT_FALLBACKS = {
  silenceMs: 1000,
  minSpeechMs: 300,
  maxUtteranceMs: 30_000,
  latchDipMs: 200,
} as const;

/** Shipped Barge-in candidate defaults: sustained non-Echo speech and dip tolerance. */
export const BARGE_IN_DEFAULTS = { minSpeechMs: 200, dipToleranceMs: 200 } as const;

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

export interface BargeInEvent {
  audio: Int16Array;
  durationMs: number;
  /** True when a provider `vad.speech_start` corroborated the local candidate. */
  corroborated: boolean;
}
