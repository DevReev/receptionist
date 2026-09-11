/** ITU-T G.711 mu-law decode: 8 kHz 8-bit telephony samples to 16-bit PCM. */
export function decodeMulaw(data: Buffer): Int16Array {
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const u = ~data[i] & 0xff;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    const magnitude = ((mantissa << 3) + 132) << exponent;
    out[i] = u & 0x80 ? -(magnitude - 132) : magnitude - 132;
  }
  return out;
}
