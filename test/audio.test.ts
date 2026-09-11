import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, decodeWavPcm, encodeMulaw, resampleLinear, wavToMulaw } from '../src/audio.ts';

function wavHeaderCheck(buf: Buffer): void {
  assert.equal(buf.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(buf.subarray(8, 12).toString('ascii'), 'WAVE');
}

describe('encodeWav', () => {
  it('writes a mono 16-bit WAV the transcriber accepts', () => {
    const pcm = new Int16Array([0, 1000, -1000, 32767, -32768]);
    const wav = encodeWav(pcm, 8000);
    wavHeaderCheck(wav);
    assert.equal(wav.length, 44 + pcm.length * 2);
    const { pcm: back, sampleRate } = decodeWavPcm(wav);
    assert.equal(sampleRate, 8000);
    assert.deepEqual(Array.from(back), Array.from(pcm));
  });

  it('round-trips silence', () => {
    const wav = encodeWav(new Int16Array(160), 8000);
    const { pcm } = decodeWavPcm(wav);
    assert.ok(pcm.every((s) => s === 0));
  });
});

describe('mulaw encode', () => {
  it('encodes silence to 0xff', () => {
    const out = encodeMulaw(new Int16Array([0, 0, 0]));
    assert.deepEqual(Array.from(out), [0xff, 0xff, 0xff]);
  });

  it('round-trips through decode within tolerance', async () => {
    const { decodeMulaw } = await import('../src/mulaw.ts');
    const pcm = new Int16Array([0, 1000, -1000, 5000, -5000]);
    const back = decodeMulaw(encodeMulaw(pcm));
    assert.equal(back.length, pcm.length);
    assert.equal(back[0], 0);
    for (let i = 1; i < pcm.length; i++) {
      assert.ok(Math.abs(back[i]! - pcm[i]!) < 600, `sample ${i}: ${back[i]} vs ${pcm[i]}`);
    }
  });
});

describe('resampleLinear', () => {
  it('downsamples 16kHz to 8kHz by halving', () => {
    const pcm = new Int16Array([0, 100, 200, 300, 400, 500, 600, 700]);
    const out = resampleLinear(pcm, 16000, 8000);
    assert.equal(out.length, 4);
  });
});

describe('wavToMulaw', () => {
  it('converts an 8kHz wav to one mulaw byte per sample', () => {
    const wav = encodeWav(new Int16Array([0, 1000, -1000, 0]), 8000);
    const mulaw = wavToMulaw(wav, 8000);
    assert.equal(mulaw.length, 4);
    assert.equal(mulaw[0], 0xff);
  });
});
