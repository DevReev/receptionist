import type { Transcription } from './app.ts';

/**
 * One call's live transcription channel. The local detector owns every
 * utterance boundary: audio is pushed as the Caller speaks, `speechStart`
 * opens the utterance, and `finalize` commits it and resolves the transcript,
 * so the Turn does not pay a REST round trip after endpointing.
 */
export interface RealtimeStt {
  /** Raw 8 kHz mulaw chunks as they arrive; buffered until `speechStart`. */
  pushAudio(mulaw: Buffer): void;
  /** Our VAD latched: flush buffered audio and open the utterance. */
  speechStart(): void;
  /** Our endpoint fired: finalize the utterance and resolve its transcript. */
  finalize(): Promise<Transcription>;
  /**
   * Explicit partial-channel capability. Declared, never inferred from the
   * presence of an `onPartial` callback: the session wires semantic Turn
   * boundaries and Backchannel classification only when the provider says it
   * has a partial channel, and uses the no-partials floor otherwise.
   */
  readonly partials: boolean;
  /** Subscribe to partials for read-only speculation and Backchannel semantics. */
  onPartial?(handler: (partial: PartialTranscript) => void): void;
  /** Session over: release the socket. */
  close(): void;
}

/**
 * Streaming partial for read-only speculation, early barge-in signals, and the
 * semantic Turn boundary. Providers that accumulate per conversation item emit
 * cumulative text: each partial extends the previous one.
 */
export interface PartialTranscript {
  text: string;
}
