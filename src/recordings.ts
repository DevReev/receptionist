import type { Recording, RecordingFetcher } from './app.ts';

const READY_POLL_MS = 800;

export class TwilioRecordingFetcher implements RecordingFetcher {
  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleepMs: (ms: number) => Promise<void>;
  private readonly attempts: number;

  constructor(opts: {
    accountSid: string;
    authToken: string;
    fetchFn?: typeof fetch;
    sleepMs?: (ms: number) => Promise<void>;
    attempts?: number;
  }) {
    this.accountSid = opts.accountSid;
    this.authToken = opts.authToken;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.sleepMs = opts.sleepMs ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.attempts = opts.attempts ?? 3;
  }

  async fetch(url: string): Promise<Recording | null> {
    const target = url.endsWith('.mp3') ? url : `${url}.mp3`;
    const auth = `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`;
    for (let i = 0; i < this.attempts; i += 1) {
      const res = await this.fetchFn(target, { headers: { Authorization: auth } });
      if (res.ok) {
        return {
          audio: Buffer.from(await res.arrayBuffer()),
          contentType: res.headers.get('content-type') ?? 'audio/mpeg',
        };
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(`recording-http-${res.status}`);
      }
      if (i < this.attempts - 1) await this.sleepMs(READY_POLL_MS);
    }
    return null;
  }
}
