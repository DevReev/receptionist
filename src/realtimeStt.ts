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
  /** Context update: terminology hints for later utterances. */
  reconfigure?(context: TranscriptionContext): void;
  /** Subscribe to partials for read-only speculation and Backchannel semantics. */
  onPartial?(handler: (partial: PartialTranscript) => void): void;
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
