import type { Transcription } from './app.ts';

/** Who decides utterance boundaries on this channel. */
export type RealtimeEndpointing = 'manual' | 'vad';

/** Provider VAD boundary event. */
export type VadEvent = 'speech_start' | 'speech_end';

/**
 * One call's live transcription channel. Audio is pushed as the Caller speaks
 * and the final transcript is read at the utterance boundary, so the Turn does
 * not pay a REST round trip after endpointing.
 */
export interface RealtimeStt {
  /** Raw 8 kHz mulaw chunks as they arrive; buffered until `speechStart`. */
  pushAudio(mulaw: Buffer): void;
  /** Our VAD latched: flush buffered audio and open the utterance. */
  speechStart(): void;
  /** Our endpoint fired: finalize the utterance and resolve its transcript. */
  finalize(): Promise<Transcription>;
  /** Boundary-gated context update: terminology hints for later utterances. */
  reconfigure?(context: TranscriptionContext): void;
  /** Subscribe to partials for read-only speculation. */
  onPartial?(handler: (partial: PartialTranscript) => void): void;
  /** Provider boundary events; present only when the provider owns boundaries. */
  onVadEvent?(handler: (event: VadEvent) => void): void;
  /** `vad` when this channel owns utterance boundaries. */
  readonly endpointing?: RealtimeEndpointing;
  /** Switch boundary ownership; applied at the next utterance boundary. */
  setEndpointing?(mode: RealtimeEndpointing): void;
  /**
   * The local detector took the boundary for an utterance the provider still
   * holds open (it stalled): release it and adopt any pending switch, so the
   * next client-owned utterance can open cleanly. Returns the utterance's
   * final when one already landed, so delivered text is not discarded.
   */
  abandonUtterance?(): Transcription | undefined;
  /** Session over: release the socket. */
  close(): void;
}

/** Structured dialogue context the transcriber can hint on. */
export interface TranscriptionContext {
  /** Comma-separated terminology prompt derived from the clinic guide. */
  prompt?: string;
  languageCode?: string;
}

/** Streaming partial for read-only speculation and early barge-in signals. */
export interface PartialTranscript {
  text: string;
  utteranceIdx?: number;
  language?: string;
}
