import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { attenuationGain, mixEcho, mixMulaw } from '../src/echoMix.ts';
import { decodeMulaw } from '../src/mulaw.ts';
import { encodeMulaw } from '../src/audio.ts';

const SILENCE = 0xff;

function pcm(mulaw: Buffer): number[] {
  return Array.from(decodeMulaw(mulaw));
}

/** A quiet 100-sample ramp, well below mulaw clipping even doubled. */
function ramp(samples: number, scale = 2000): Buffer {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i++) out[i] = Math.round(((i % 10) / 10 - 0.5) * 2 * scale);
  return encodeMulaw(out);
}

describe('echo mix', () => {
  it('converts attenuation decibels to a linear gain', () => {
    assert.equal(attenuationGain(0), 1);
    assert.ok(Math.abs(attenuationGain(-20) - 0.1) < 1e-9);
    assert.ok(Math.abs(attenuationGain(-6) - 0.501187) < 1e-5);
    assert.equal(attenuationGain(-Infinity), 0);
  });

  it('sums caller and reference sample-wise', () => {
    const caller = encodeMulaw(Int16Array.from([1000, -1000, 500, 0]));
    const reference = encodeMulaw(Int16Array.from([2000, 2000, -500, 0]));
    const mixed = pcm(mixMulaw(caller, reference, 1));
    // mu-law quantization error is bounded by ~2% of full scale.
    assert.ok(Math.abs(mixed[0]! - 3000) < 200);
    assert.ok(Math.abs(mixed[1]! - 1000) < 200);
    assert.ok(Math.abs(mixed[2]! - 0) < 200);
    assert.ok(Math.abs(mixed[3]! - 0) < 200);
  });

  it('keeps the longer input length and treats the shorter as silence', () => {
    const caller = Buffer.alloc(4, SILENCE);
    const reference = encodeMulaw(Int16Array.from([1000, 1000, 1000]));
    assert.equal(mixMulaw(caller, reference, 1).length, 4);
    assert.equal(mixMulaw(reference, caller, 1).length, 4);
  });

  it('delays and attenuates the reference into the caller audio', () => {
    const delayMs = 40; // 320 samples at 8 kHz
    const caller = Buffer.alloc(800, SILENCE);
    const reference = ramp(160);
    const mixed = pcm(mixEcho(caller, reference, { delayMs, attenuationDb: -20 }));
    assert.equal(mixed.length, 800);
    for (let i = 0; i < 320; i++) assert.equal(mixed[i], 0, `sample ${i} must stay silent before the delay`);
    for (let i = 0; i < 160; i++) {
      const expected = (decodeMulaw(reference)[i]! * 0.1);
      assert.ok(Math.abs(mixed[320 + i]! - expected) < 200, `sample ${320 + i}`);
    }
    for (let i = 480; i < 800; i++) assert.equal(mixed[i], 0, `sample ${i} must fade after the reference ends`);
  });

  it('extends the output so a delayed reference is kept whole', () => {
    const caller = Buffer.alloc(100, SILENCE);
    const reference = Buffer.alloc(200, 0x00);
    const mixed = mixEcho(caller, reference, { delayMs: 60, attenuationDb: 0 });
    assert.equal(mixed.length, 480 + 200);
  });

  it('mixes double-talk: caller speech over its own returning echo', () => {
    const caller = encodeMulaw(Int16Array.from(Array.from({ length: 160 }, () => 3000)));
    const reference = encodeMulaw(Int16Array.from(Array.from({ length: 160 }, () => -3000)));
    const mixed = pcm(mixEcho(caller, reference, { delayMs: 0, attenuationDb: 0 }));
    for (const sample of mixed) assert.ok(Math.abs(sample) < 300, `expected cancellation, got ${sample}`);
  });
});
