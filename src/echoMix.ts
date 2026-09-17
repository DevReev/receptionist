import { encodeMulaw } from './audio.ts';
import { decodeMulaw } from './mulaw.ts';

/** Delay of the returning Echo and how loud it is relative to the reference. */
export interface EchoMixOptions {
  /** Echo return delay in milliseconds. */
  delayMs: number;
  /** Return loss in decibels (negative); -20 dB keeps ~10% of the reference amplitude. */
  attenuationDb: number;
  /** Samples per second of the mulaw bytes; telephony is 8000. */
  sampleRate?: number;
}

const DEFAULT_SAMPLE_RATE = 8000;

/** Linear amplitude gain for an attenuation in decibels. */
export function attenuationGain(attenuationDb: number): number {
  return 10 ** (attenuationDb / 20);
}

/**
 * Sample-wise sum of a Caller frame and a reference frame, both 8 kHz mu-law.
 * The output is as long as the longer input; the shorter one counts as silence.
 */
export function mixMulaw(caller: Buffer, reference: Buffer, gain: number): Buffer {
  const callerPcm = decodeMulaw(caller);
  const referencePcm = decodeMulaw(reference);
  const length = Math.max(callerPcm.length, referencePcm.length);
  const mixed = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const callerSample = i < callerPcm.length ? callerPcm[i]! : 0;
    const referenceSample = i < referencePcm.length ? referencePcm[i]! * gain : 0;
    mixed[i] = Math.max(-32768, Math.min(32767, Math.round(callerSample + referenceSample)));
  }
  return encodeMulaw(mixed);
}

/**
 * The Receptionist's own voice returning through the Caller's phone: the
 * reference signal, attenuated and delayed, summed into the Caller audio.
 * The output keeps the delayed reference whole, so it may outlast the Caller.
 */
export function mixEcho(caller: Buffer, reference: Buffer, opts: EchoMixOptions): Buffer {
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const delaySamples = Math.max(0, Math.round((opts.delayMs / 1000) * sampleRate));
  const delayed = Buffer.alloc(delaySamples + reference.length, 0xff);
  reference.copy(delayed, delaySamples);
  return mixMulaw(caller, delayed, attenuationGain(opts.attenuationDb));
}
