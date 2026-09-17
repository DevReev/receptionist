import type { Transcriber, Transcription } from './app.ts';
import { wavToMulaw } from './audio.ts';
import type { TraceFn } from './trace.ts';
import type { SynthesizedAudio, Tts } from './tts.ts';

/** Sarvam STT (`POST {baseUrl}/speech-to-text`) — Saarika/Saaras dialect. */
export interface SarvamSttConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  languageCode: string;
  mode: string;
}

export class SarvamTranscriber implements Transcriber {
  private readonly stt: SarvamSttConfig;
  private readonly fetchFn: typeof fetch;
  private readonly onTrace?: TraceFn;

  constructor(opts: { stt: SarvamSttConfig; fetchFn?: typeof fetch; onTrace?: TraceFn }) {
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
      form.append('language_code', this.stt.languageCode);
      form.append('mode', this.stt.mode);
      const res = await this.fetchFn(`${this.stt.baseUrl}/speech-to-text`, {
        method: 'POST',
        headers: { 'api-subscription-key': this.stt.apiKey },
        body: form,
      });
      if (!res.ok) throw new Error(`sarvam-stt-http-${res.status}`);
      const data = (await res.json()) as { transcript?: unknown };
      const text = typeof data.transcript === 'string' ? data.transcript : '';
      this.onTrace?.({
        component: 'stt',
        event: 'rest-done',
        ms: Date.now() - started,
        chars: text.length,
        noSpeech: text.trim().length === 0,
      });
      return { text, noSpeech: text.trim().length === 0 };
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

/** Sarvam TTS (`POST {baseUrl}/text-to-speech`) — Bulbul dialect. */
export interface SarvamTtsConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  speaker: string;
  languageCode: string;
  sampleRate: number;
}

export class SarvamTts implements Tts {
  private readonly cfg: SarvamTtsConfig;
  private readonly fetchFn: typeof fetch;
  private readonly onTrace?: TraceFn;

  constructor(opts: { tts: SarvamTtsConfig; fetchFn?: typeof fetch; onTrace?: TraceFn }) {
    this.cfg = opts.tts;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.onTrace = opts.onTrace;
  }

  async synthesize(text: string): Promise<SynthesizedAudio> {
    const started = Date.now();
    this.onTrace?.({ component: 'tts', event: 'rest-start', chars: text.length });
    try {
      const res = await this.fetchFn(`${this.cfg.baseUrl}/text-to-speech`, {
        method: 'POST',
        headers: {
          'api-subscription-key': this.cfg.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          language_code: this.cfg.languageCode,
          speaker: this.cfg.speaker,
          model: this.cfg.model,
          speech_sample_rate: this.cfg.sampleRate,
          output_audio_codec: 'mulaw',
        }),
      });
      if (!res.ok) throw new Error(`sarvam-tts-http-${res.status}`);
      const data = (await res.json()) as { audios?: unknown };
      const first = Array.isArray(data.audios) ? data.audios[0] : undefined;
      if (typeof first !== 'string' || first.length === 0) throw new Error('sarvam-tts-empty');
      const bytes = Buffer.from(first, 'base64');
      // Provider docs still describe WAV in places; keep one sniff so a
      // legacy response still plays, but native mulaw pays no parsing cost.
      const audio = isWav(bytes) ? wavToMulaw(bytes) : bytes;
      this.onTrace?.({
        component: 'tts',
        event: 'rest-done',
        ms: Date.now() - started,
        bytes: audio.length,
        codec: isWav(bytes) ? 'wav' : 'mulaw',
      });
      return { audio };
    } catch (err) {
      this.onTrace?.({
        component: 'tts',
        event: 'rest-error',
        ms: Date.now() - started,
        detail: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

function isWav(bytes: Buffer): boolean {
  return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE';
}
