import type { Transcriber, Transcription } from './app.ts';

const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';

/** Average segment no_speech_prob above this counts as non-speech (music, noise, silence). */
const NO_SPEECH_THRESHOLD = 0.6;

interface VerboseSegment {
  no_speech_prob?: unknown;
}

export class WhisperTranscriber implements Transcriber {
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: { apiKey: string; fetchFn?: typeof fetch }) {
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async transcribe(audio: Buffer, contentType: string): Promise<Transcription> {
    const form = new FormData();
    const bytes = new Uint8Array(audio);
    form.append('file', new Blob([bytes.buffer as ArrayBuffer], { type: contentType || 'audio/mpeg' }), 'turn.mp3');
    form.append('model', 'whisper-1');
    form.append('language', 'en');
    form.append('response_format', 'verbose_json');
    const res = await this.fetchFn(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    if (!res.ok) throw new Error(`whisper-http-${res.status}`);
    const data = (await res.json()) as { text?: unknown; segments?: unknown };
    const text = typeof data.text === 'string' ? data.text : '';
    const segments = Array.isArray(data.segments) ? (data.segments as VerboseSegment[]) : [];
    const probs = segments
      .map((s) => s.no_speech_prob)
      .filter((v): v is number => typeof v === 'number');
    const avg = probs.length > 0 ? probs.reduce((a, b) => a + b, 0) / probs.length : 0;
    return { text, noSpeech: probs.length > 0 && avg > NO_SPEECH_THRESHOLD };
  }
}
