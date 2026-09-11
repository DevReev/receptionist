import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { InferenceSession } from 'onnxruntime-node';
import { SileroVad } from '../src/sileroVad.ts';

interface SeenWindow {
  samples: number[];
}

/** Stub inference: records each 256-sample window, always reports speech. */
function stubSession(seen: SeenWindow[]): InferenceSession {
  return {
    run: async (feeds: Record<string, { data: Float32Array }>) => {
      const data = feeds['input']!.data;
      seen.push({ samples: Array.from(data, (v) => Math.round(v * 32768)) });
      return {
        output: { data: new Float32Array([0.9]) },
        stateN: { data: new Float32Array(2 * 1 * 128) },
      };
    },
  } as unknown as InferenceSession;
}

function frame160(base: number): Int16Array {
  const out = new Int16Array(160);
  for (let i = 0; i < 160; i++) out[i] = base + i;
  return out;
}

describe('SileroVad sub-window carry', () => {
  it('retains Twilio-sized frames until a full 256-sample window is ready', async () => {
    const seen: SeenWindow[] = [];
    const vad = SileroVad.fromSession(stubSession(seen));
    // One 160-sample frame is smaller than the window: no inference yet,
    // but the audio must be kept, not dropped.
    assert.equal(await vad.score(frame160(0)), 0);
    assert.equal(seen.length, 0);
    // The second frame completes the first window: samples 0..159 then 1000..1095.
    assert.ok(Math.abs((await vad.score(frame160(1000))) - 0.9) < 1e-6);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]!.samples, [...Array.from({ length: 160 }, (_, i) => i), ...Array.from({ length: 96 }, (_, i) => 1000 + i)]);
    // Remainder (1096..1159, 64 samples) carries; a fourth frame completes
    // the second window: 1096..1159 then all of 2000..2159 then 3000..3031.
    assert.ok(Math.abs((await vad.score(frame160(2000))) - 0.9) < 1e-6);
    assert.equal(seen.length, 1);
    assert.ok(Math.abs((await vad.score(frame160(3000))) - 0.9) < 1e-6);
    assert.equal(seen.length, 2);
    assert.deepEqual(
      seen[1]!.samples.slice(0, 64),
      Array.from({ length: 64 }, (_, i) => 1096 + i),
    );
    assert.deepEqual(
      seen[1]!.samples.slice(64, 224),
      Array.from({ length: 160 }, (_, i) => 2000 + i),
    );
    assert.deepEqual(
      seen[1]!.samples.slice(224),
      Array.from({ length: 32 }, (_, i) => 3000 + i),
    );
  });
});
