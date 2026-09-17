import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeMulaw } from '../src/mulaw.ts';
import { SileroVad } from '../src/sileroVad.ts';

const FRAME_BYTES = 160; // 20 ms of 8 kHz mulaw, the Twilio media frame size.

describe('mulaw decode', () => {
  it('decodes known vectors', () => {
    assert.equal(decodeMulaw(Buffer.from([0xff]))[0], 0);
    assert.equal(decodeMulaw(Buffer.from([0x00]))[0], -32124);
    assert.equal(decodeMulaw(Buffer.from([0x80]))[0], 32124);
  });

  it('decodes silence to near-zero', () => {
    const pcm = decodeMulaw(Buffer.alloc(FRAME_BYTES, 0xff));
    assert.equal(pcm.length, FRAME_BYTES);
    assert.ok(pcm.every((s) => s === 0));
  });
});

describe('silero backend', () => {
  it('loads the model and scores silence low', async () => {
    const vad = await SileroVad.load('./models/silero_vad.onnx');
    const prob = await vad.score(new Int16Array(256));
    assert.ok(prob >= 0 && prob <= 1);
    assert.ok(prob < 0.5, `expected silence to score low, got ${prob}`);
    vad.reset();
  });
});
