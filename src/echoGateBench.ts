import { LIVE_SAMPLE_RATE } from './audio.ts';
import { EchoGate, rms } from './echoGate.ts';
import { mixEcho, type EchoMixOptions } from './echoMix.ts';
import { decodeMulaw } from './mulaw.ts';
import { ECHO_GATE_BARS } from './turnBench.ts';

/** 20 ms of 8 kHz mulaw, the Twilio media cadence. */
export const ECHO_BENCH_FRAME = LIVE_SAMPLE_RATE / 50;

/** Inbound RMS below this counts as silence, for ground-truth labels only. */
const ENERGY_FLOOR_RMS = 60;
/** Caller energy this fraction of the Echo makes a frame audibly double-talk. */
const AUDIBLE_RATIO = 0.25;

export interface EchoBenchCase {
  name: string;
  /** Captured or synthetic Caller audio, 8 kHz mulaw. */
  caller: Buffer;
  /** The Receptionist's outbound audio, 8 kHz mulaw. */
  reference: Buffer;
  mix: EchoMixOptions;
}

export interface EchoBenchCounts {
  /** Frames with returned Echo and no meaningful Caller energy: the gate must flag these. */
  pureEchoFrames: number;
  /** Pure-Echo frames the gate passed as Caller. */
  echoFalsePasses: number;
  /** Caller-dominant frames: the gate must pass these, Echo present or not. */
  callerFrames: number;
  /** Caller-dominant frames the gate blocked as Echo. */
  callerFalseBlocks: number;
  /** Echo-dominant double-talk: neither label is wrong, so it is reported, not scored. */
  doubleTalkFrames: number;
  /** Frames with neither; not scored. */
  silenceFrames: number;
  /** Every frame the gate classified. */
  decisions: number;
}

export interface EchoBenchCaseResult {
  name: string;
  delayMs: number;
  attenuationDb: number;
  counts: EchoBenchCounts;
}

export interface EchoBenchSummary {
  cases: number;
  pureEchoFrames: number;
  echoFalsePasses: number;
  callerFrames: number;
  callerFalseBlocks: number;
  doubleTalkFrames: number;
  silenceFrames: number;
  decisions: number;
  falsePassRate: number;
  falseBlockRate: number;
  /** False-pass and false-block rates inside the agreed bars. */
  pass: boolean;
}

/** RMS of one frame's sample range, clipped to the signal. */
function windowRms(pcm: Int16Array, start: number, end: number): number {
  const from = Math.max(0, start);
  const to = Math.min(pcm.length, end);
  if (to <= from) return 0;
  return rms(pcm.subarray(from, to));
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/**
 * Run one Echo-mixed fixture through a fresh gate, frame by frame, and score
 * every classification against the known mix: the caller side says where
 * speech is, the delay says where the returning Echo is. The gate sees the
 * same reference playout the Caller's phone would have heard.
 *
 * Labels are energy-relative: pure Echo means Caller energy is negligible
 * against the return, Caller means Caller energy dominates it, and frames in
 * between are double-talk whose classification is defensible either way, so
 * they are reported but not scored.
 */
export function classifyEchoMix(bench: EchoBenchCase): EchoBenchCounts {
  const gate = new EchoGate();
  const inbound = mixEcho(bench.caller, bench.reference, bench.mix);
  const caller = decodeMulaw(bench.caller);
  const reference = decodeMulaw(bench.reference);
  const delaySamples = Math.round((bench.mix.delayMs / 1000) * LIVE_SAMPLE_RATE);
  const frames = Math.ceil(inbound.length / ECHO_BENCH_FRAME);
  const counts: EchoBenchCounts = {
    pureEchoFrames: 0,
    echoFalsePasses: 0,
    callerFrames: 0,
    callerFalseBlocks: 0,
    doubleTalkFrames: 0,
    silenceFrames: 0,
    decisions: 0,
  };
  for (let frame = 0; frame < frames; frame++) {
    const start = frame * ECHO_BENCH_FRAME;
    const referenceFrame = bench.reference.subarray(start, start + ECHO_BENCH_FRAME);
    if (referenceFrame.length > 0) gate.pushReference(referenceFrame);
    const decision = gate.classify(decodeMulaw(inbound.subarray(start, start + ECHO_BENCH_FRAME)));
    counts.decisions += 1;
    const callerRms = windowRms(caller, start, start + ECHO_BENCH_FRAME);
    const echoRms = windowRms(reference, start - delaySamples, start + ECHO_BENCH_FRAME - delaySamples);
    const echoActive = echoRms >= ENERGY_FLOOR_RMS;
    if (echoActive) {
      if (callerRms >= Math.max(ENERGY_FLOOR_RMS, echoRms)) {
        counts.callerFrames += 1;
        if (decision.echo) counts.callerFalseBlocks += 1;
        continue;
      }
      if (callerRms >= Math.max(ENERGY_FLOOR_RMS, echoRms * AUDIBLE_RATIO)) {
        counts.doubleTalkFrames += 1;
        continue;
      }
      counts.pureEchoFrames += 1;
      if (!decision.echo) counts.echoFalsePasses += 1;
      continue;
    }
    if (callerRms >= ENERGY_FLOOR_RMS) {
      counts.callerFrames += 1;
      if (decision.echo) counts.callerFalseBlocks += 1;
      continue;
    }
    counts.silenceFrames += 1;
  }
  return counts;
}

/** Pool every case's frames and score the rates against the agreed bars. */
export function aggregateEchoBench(cases: EchoBenchCaseResult[]): EchoBenchSummary {
  let pureEchoFrames = 0;
  let echoFalsePasses = 0;
  let callerFrames = 0;
  let callerFalseBlocks = 0;
  let doubleTalkFrames = 0;
  let silenceFrames = 0;
  let decisions = 0;
  for (const entry of cases) {
    pureEchoFrames += entry.counts.pureEchoFrames;
    echoFalsePasses += entry.counts.echoFalsePasses;
    callerFrames += entry.counts.callerFrames;
    callerFalseBlocks += entry.counts.callerFalseBlocks;
    doubleTalkFrames += entry.counts.doubleTalkFrames;
    silenceFrames += entry.counts.silenceFrames;
    decisions += entry.counts.decisions;
  }
  const falsePassRate = rate(echoFalsePasses, pureEchoFrames);
  const falseBlockRate = rate(callerFalseBlocks, callerFrames);
  return {
    cases: cases.length,
    pureEchoFrames,
    echoFalsePasses,
    callerFrames,
    callerFalseBlocks,
    doubleTalkFrames,
    silenceFrames,
    decisions,
    falsePassRate,
    falseBlockRate,
    pass: falsePassRate <= ECHO_GATE_BARS.falsePassRate && falseBlockRate <= ECHO_GATE_BARS.falseBlockRate,
  };
}
