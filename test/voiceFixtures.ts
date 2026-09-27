/** Deterministic speech-like 8 kHz PCM, so two seeds are uncorrelated signals. */
export function voice(samples: number, seed = 1): Int16Array {
  const pcm = new Int16Array(samples);
  let state = seed >>> 0;
  const rand = (): number => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  for (let i = 0; i < samples; i++) {
    const t = i / 8000;
    const pitch = 140 + 60 * Math.sin(2 * Math.PI * 0.7 * t) + 20 * rand();
    pcm[i] = Math.round(6000 * Math.sin(2 * Math.PI * pitch * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t)));
  }
  return pcm;
}

const FRAME = 160; // 20 ms of 8 kHz telephony

/** The returning Echo of `ref` for one frame, attenuated and delayed. */
export function echoFrame(ref: Int16Array, frameIndex: number, delaySamples: number, gain: number): Int16Array {
  const out = new Int16Array(FRAME);
  for (let i = 0; i < FRAME; i++) {
    const src = frameIndex * FRAME + i - delaySamples;
    if (src >= 0 && src < ref.length) out[i] = Math.round(ref[src]! * gain);
  }
  return out;
}

/**
 * Stress fixture for correlated double-talk: the Caller shares the
 * reference's spectral shape (tonal overlap, same waveform) at full voice
 * plus independent speech, over the quiet returning Echo. It correlates with
 * the reference well into the old always-Echo band (>= 0.85) while carrying
 * ~+20 dB more energy than the learned return, so only residual/level
 * evidence tells it apart from a louder Echo path.
 */
export function correlatedDoubleTalkFrame(
  ref: Int16Array,
  other: Int16Array,
  frameIndex: number,
  delaySamples: number,
): Int16Array {
  const out = new Int16Array(FRAME);
  for (let i = 0; i < FRAME; i++) {
    const src = frameIndex * FRAME + i - delaySamples;
    const s = src >= 0 && src < ref.length ? ref[src]! : 0;
    const u = other[(frameIndex * FRAME + i) % other.length]!;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(s * 0.125 + s * 1.0 + u * 0.5)));
  }
  return out;
}
