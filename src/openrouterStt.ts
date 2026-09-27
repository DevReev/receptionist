import type { Transcriber, Transcription } from './app.ts';
import type { TraceFn } from './trace.ts';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'openai/gpt-4o-transcribe';

/** OpenRouter STT (`POST {baseUrl}/audio/transcriptions`) — completed-utterance request. */
export interface OpenRouterSttConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export class OpenRouterStt implements Transcriber {
  private readonly stt: Required<OpenRouterSttConfig>;
  private readonly fetchFn: typeof fetch;
  private readonly onTrace?: TraceFn;

  constructor(opts: { stt: OpenRouterSttConfig; fetchFn?: typeof fetch; onTrace?: TraceFn }) {
    this.stt = {
      apiKey: opts.stt.apiKey,
      baseUrl: opts.stt.baseUrl ?? DEFAULT_BASE_URL,
      model: opts.stt.model ?? DEFAULT_MODEL,
    };
    this.fetchFn = opts.fetchFn ?? fetch;
    this.onTrace = opts.onTrace;
  }

  async transcribe(audio: Buffer, contentType: string, signal?: AbortSignal): Promise<Transcription> {
    const started = Date.now();
    this.onTrace?.({ component: 'stt', event: 'openrouter-start', bytes: audio.length, model: this.stt.model });
    try {
      const bytes = new Uint8Array(audio);
      const type = contentType || 'audio/mpeg';
      const filename = type.toLowerCase().includes('wav') ? 'turn.wav' : 'turn.mp3';
      const form = new FormData();
      form.append('file', new Blob([bytes.buffer as ArrayBuffer], { type }), filename);
      form.append('model', this.stt.model);
      const res = await this.fetchFn(`${this.stt.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.stt.apiKey}` },
        body: form,
        signal,
      });
      if (!res.ok) throw new Error(`openrouter-stt-http-${res.status}`);
      const data = (await res.json()) as { text?: unknown; transcript?: unknown };
      const text =
        typeof data.text === 'string' ? data.text : typeof data.transcript === 'string' ? data.transcript : '';
      const noSpeech = text.trim().length === 0;
      this.onTrace?.({
        component: 'stt',
        event: 'openrouter-done',
        ms: Date.now() - started,
        chars: text.length,
        noSpeech,
      });
      return { text, noSpeech };
    } catch (err) {
      this.onTrace?.({
        component: 'stt',
        event: 'openrouter-error',
        ms: Date.now() - started,
        detail: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

/** GET /models?output_modalities=transcription → sorted model ids. Used at startup validation. */
export async function discoverTranscriptionModels(opts: {
  apiKey: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}): Promise<string[]> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const fetchFn = opts.fetchFn ?? fetch;
  const res = await fetchFn(`${baseUrl}/models?output_modalities=transcription`, {
    headers: { Authorization: `Bearer ${opts.apiKey}` },
  });
  if (!res.ok) throw new Error(`openrouter-models-http-${res.status}`);
  const data = (await res.json().catch(() => null)) as { data?: unknown } | null;
  if (!Array.isArray(data?.data)) return [];
  return data.data
    .map((entry) => (entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === 'string')
    .sort();
}
