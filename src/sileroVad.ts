import { InferenceSession, Tensor } from 'onnxruntime-node';
import type { Vad } from './endpoint.ts';

/** Silero VAD v5 fixed window at 8 kHz; state is per call, the session is shared. */
const WINDOW_SAMPLES = 256;
const STATE_LENGTH = 2 * 1 * 128;

export class SileroVad implements Vad {
  private readonly session: InferenceSession;
  private state: Float32Array;
  private carry: Int16Array;
  private lastProb = 0;

  private constructor(session: InferenceSession) {
    this.session = session;
    this.state = new Float32Array(STATE_LENGTH);
    this.carry = new Int16Array(0);
  }  static async load(modelPath: string): Promise<SileroVad> {
    const session = await InferenceSession.create(modelPath, {
      interOpNumThreads: 1,
      intraOpNumThreads: 1,
    });
    return new SileroVad(session);
  }

  /** Sealed-session factory for tests: real windowing/carry, stubbed inference. */
  static fromSession(session: InferenceSession): SileroVad {
    return new SileroVad(session);
  }

  /** Same model, fresh per-call state. */
  fork(): SileroVad {
    return new SileroVad(this.session);
  }

  reset(): void {
    this.state = new Float32Array(STATE_LENGTH);
    this.carry = new Int16Array(0);
    this.lastProb = 0;
  }

  async score(pcm: Int16Array): Promise<number> {
    const combined = new Int16Array(this.carry.length + pcm.length);
    combined.set(this.carry, 0);
    combined.set(pcm, this.carry.length);
    const fullWindows = Math.floor(combined.length / WINDOW_SAMPLES);
    // Keep the remainder even when no full window is ready yet — Twilio
    // delivers 160-sample frames, so dropping it here would starve the
    // model forever and endpointing would never fire.
    this.carry = combined.slice(fullWindows * WINDOW_SAMPLES);
    if (fullWindows === 0) return this.lastProb;
    let prob = this.lastProb;
    for (let i = 0; i < fullWindows; i++) {
      prob = await this.runWindow(combined.subarray(i * WINDOW_SAMPLES, (i + 1) * WINDOW_SAMPLES));
    }
    this.lastProb = prob;
    return prob;
  }

  private async runWindow(window: Int16Array): Promise<number> {
    const input = new Float32Array(WINDOW_SAMPLES);
    for (let i = 0; i < WINDOW_SAMPLES; i++) input[i] = window[i] / 32768;
    const feeds = {
      input: new Tensor('float32', input, [1, WINDOW_SAMPLES]),
      state: new Tensor('float32', this.state, [2, 1, 128]),
      sr: new Tensor('int64', BigInt64Array.from([8000n]), [1]),
    };
    const out = await this.session.run(feeds);
    const prob = (out['output'].data as Float32Array)[0];
    this.state = (out['stateN'].data as Float32Array).slice();
    return prob;
  }
}
