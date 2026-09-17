import type { Transcriber, Transcription } from './app.ts';
import type { TraceFn } from './trace.ts';

/** Per-segment gates for hallucination-prone decodes (research/whisper-transcription.md). */
const NO_SPEECH_THRESHOLD = 0.6;
const LOGPROB_THRESHOLD = -1.0;
const COMPRESSION_THRESHOLD = 2.4;

interface VerboseSegment {
  no_speech_prob?: unknown;
  avg_logprob?: unknown;
  compression_ratio?: unknown;
}

function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

export interface SttConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export class WhisperTranscriber implements Transcriber {
  private readonly stt: SttConfig;
  private readonly fetchFn: typeof fetch;
  private readonly onTrace?: TraceFn;

  constructor(opts: { stt: SttConfig; fetchFn?: typeof fetch; onTrace?: TraceFn }) {
    this.stt = opts.stt;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.onTrace = opts.onTrace;
  }

  async transcribe(audio: Buffer, contentType: string): Promise<Transcription> {
    const started = Date.now();
    this.onTrace?.({ component: 'stt', event: 'rest-start', bytes: audio.length, model: this.stt.model });
    try {
      const bytes = new Uint8Array(audio);
      const form = new FormData();
      const type = contentType || 'audio/mpeg';
      const filename = type.toLowerCase().includes('wav') ? 'turn.wav' : 'turn.mp3';
      form.append('file', new Blob([bytes.buffer as ArrayBuffer], { type }), filename);
      form.append('model', this.stt.model);
      form.append('language', 'en');
      // No vocabulary prompt: Whisper echoes it verbatim on unclear or short
      // clips ("...a phone call to a medical clinic"), which we then reply to.
      form.append('temperature', '0');
      form.append('response_format', 'verbose_json');
      const res = await this.fetchFn(`${this.stt.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.stt.apiKey}` },
        body: form,
      });
      if (!res.ok) throw new Error(`whisper-http-${res.status}`);
      const data = (await res.json()) as { text?: unknown; segments?: unknown };
      const text = typeof data.text === 'string' ? data.text : '';
      const segments = Array.isArray(data.segments) ? (data.segments as VerboseSegment[]) : [];
      // No-speech only when Whisper is both unsure it heard speech AND decoded
      // with low confidence; a quiet-but-confident "Thank you." must pass.
      const nonSpeech = segments.map((s) => ({
        noSpeech: num(s.no_speech_prob),
        logprob: num(s.avg_logprob),
      }));
      const quietUncertain =
        nonSpeech.length > 0 &&
        nonSpeech.every(
          (s) => s.noSpeech !== null && s.noSpeech > NO_SPEECH_THRESHOLD && s.logprob !== null && s.logprob < LOGPROB_THRESHOLD,
        );
      // Repetitive decodes are a hallucination signature regardless of confidence.
      const failedDecode = segments.some((s) => {
        const ratio = num(s.compression_ratio);
        return ratio !== null && ratio > COMPRESSION_THRESHOLD;
      });
      this.onTrace?.({
        component: 'stt',
        event: 'rest-done',
        ms: Date.now() - started,
        chars: text.length,
        noSpeech: quietUncertain || failedDecode,
        segments: segments.length,
      });
      return { text, noSpeech: quietUncertain || failedDecode };
    } catch (err) {
      this.onTrace?.({
        component: 'stt',
        event: 'rest-error',
        ms: Date.now() - started,
        detail: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}
