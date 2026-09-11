/** PCM/WAV/mulaw conversions for the live Stream session. Telephony is 8 kHz. */

export const LIVE_SAMPLE_RATE = 8000;

export function encodeWav(pcm: Int16Array, sampleRate = LIVE_SAMPLE_RATE): Buffer {
  const dataBytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i++) {
    buf.writeInt16LE(pcm[i]!, 44 + i * 2);
  }
  return buf;
}

export function decodeWavPcm(wav: Buffer): { pcm: Int16Array; sampleRate: number } {
  if (wav.length < 44) throw new Error('wav-too-short');
  if (wav.subarray(0, 4).toString('ascii') !== 'RIFF') throw new Error('wav-no-riff');
  if (wav.subarray(8, 12).toString('ascii') !== 'WAVE') throw new Error('wav-no-wave');
  if (wav.subarray(12, 16).toString('ascii') !== 'fmt ') throw new Error('wav-no-fmt');
  const audioFormat = wav.readUInt16LE(20);
  if (audioFormat !== 1) throw new Error('wav-not-pcm');
  const channels = wav.readUInt16LE(22);
  if (channels !== 1 && channels !== 2) throw new Error('wav-channels');
  const sampleRate = wav.readUInt32LE(24);
  const bits = wav.readUInt16LE(34);
  if (bits !== 16) throw new Error('wav-bits');
  // Find the data chunk (OpenAI wavs put it right after fmt, but scan to be safe).
  let offset = 36;
  while (offset + 8 <= wav.length) {
    const id = wav.subarray(offset, offset + 4).toString('ascii');
    const size = wav.readUInt32LE(offset + 4);
    if (id === 'data') {
      const start = offset + 8;
      const frames = Math.floor(size / 2 / channels);
      const pcm = new Int16Array(frames);
      for (let i = 0; i < frames; i++) {
        if (channels === 1) {
          pcm[i] = wav.readInt16LE(start + i * 2);
        } else {
          const left = wav.readInt16LE(start + i * 4);
          const right = wav.readInt16LE(start + i * 4 + 2);
          pcm[i] = Math.round((left + right) / 2);
        }
      }
      return { pcm, sampleRate };
    }
    offset += 8 + size;
  }
  throw new Error('wav-no-data');
}

/** G.711 mu-law encode: 16-bit PCM to 8-bit telephony samples. */
export function encodeMulawSample(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  let s = Math.max(-32768, Math.min(32767, Math.trunc(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (sign !== 0) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent -= 1, mask >>= 1) {
    // walk down to the highest set bit
  }
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

export function encodeMulaw(pcm: Int16Array): Buffer {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = encodeMulawSample(pcm[i]!);
  return out;
}

export function resampleLinear(pcm: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) return pcm.slice();
  if (pcm.length === 0) return new Int16Array(0);
  const outLen = Math.max(1, Math.round((pcm.length * toRate) / fromRate));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = (i * pcm.length) / outLen;
    const lo = Math.floor(pos);
    const hi = Math.min(pcm.length - 1, lo + 1);
    const frac = pos - lo;
    out[i] = Math.round(pcm[lo]! * (1 - frac) + pcm[hi]! * frac);
  }
  return out;
}

/** Provider WAV (any rate) to 8 kHz mulaw bytes ready for the media stream. */
export function wavToMulaw(wav: Buffer, targetRate = LIVE_SAMPLE_RATE): Buffer {
  const { pcm, sampleRate } = decodeWavPcm(wav);
  const resampled = sampleRate === targetRate ? pcm : resampleLinear(pcm, sampleRate, targetRate);
  return encodeMulaw(resampled);
}
