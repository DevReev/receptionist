import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeMulaw } from '../src/audio.ts';
import { TurnTaking } from '../src/turnTaking.ts';
import type { BargeInEvent, Utterance, Vad } from '../src/endpoint.ts';
import type { EchoDecision } from '../src/echoGate.ts';

const FRAME = 160; // 20 ms of 8 kHz telephony
const POLICY = { silenceMs: 700, minSpeechMs: 300, maxUtteranceMs: 30000, threshold: 0.1, latchDipMs: 200 };

/** Deterministic speech-like PCM, so two seeds are uncorrelated signals. */
function voice(samples: number, seed = 1): Int16Array {
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

function echoFrame(ref: Int16Array, frameIndex: number, delaySamples: number, gain: number): Int16Array {
  const out = new Int16Array(FRAME);
  for (let i = 0; i < FRAME; i++) {
    const src = frameIndex * FRAME + i - delaySamples;
    if (src >= 0 && src < ref.length) out[i] = Math.round(ref[src]! * gain);
  }
  return out;
}

const scriptVad = (): Vad => ({ score: async () => 0.9, reset: () => {} });

interface Harness {
  turnTaking: TurnTaking;
  decisions: EchoDecision[];
  utterances: Utterance[];
  bargeIns: BargeInEvent[];
  upstream: Buffer[];
}

function harness(): Harness {
  const decisions: EchoDecision[] = [];
  const utterances: Utterance[] = [];
  const bargeIns: BargeInEvent[] = [];
  const upstream: Buffer[] = [];
  const turnTaking = new TurnTaking({
    vad: scriptVad(),
    policy: POLICY,
    detection: 'hybrid',
    observer: {
      onUtterance: (utterance) => utterances.push(utterance),
      onBargeIn: (event) => bargeIns.push(event),
      onUpstreamFrame: (frame) => upstream.push(frame),
      onEchoDecision: (decision) => decisions.push(decision),
    },
  });
  return { turnTaking, decisions, utterances, bargeIns, upstream };
}

describe('turn taking echo gate', () => {
  it('flags returned Echo as Echo while the Receptionist speaks, without segmenting or stopping', async () => {
    const h = harness();
    const ref = voice(FRAME * 200, 3);
    for (let t = 0; t < 5; t++) {
      await h.turnTaking.receiveAudio(encodeMulaw(voice(FRAME, 90 + t)));
    }
    h.turnTaking.startSpeaking();
    h.upstream.length = 0;
    let echoed = 0;
    for (let t = 0; t < 100; t++) {
      h.turnTaking.retainReference(encodeMulaw(ref.subarray(t * FRAME, (t + 1) * FRAME)));
      await h.turnTaking.receiveAudio(encodeMulaw(echoFrame(ref, t, 960, 0.125)));
      if (t >= 7 && h.decisions[t]!.echo) echoed += 1;
    }
    assert.equal(h.decisions.length, 100);
    assert.ok(echoed >= 92, `echo frames flagged: ${echoed}/93`);
    assert.equal(h.utterances.length, 0);
    assert.equal(h.bargeIns.length, 0);
    assert.equal(h.upstream.length, 0);
  });

  it('passes clean Caller speech while the Receptionist speaks', async () => {
    const h = harness();
    const ref = voice(FRAME * 100, 3);
    const caller = voice(FRAME * 100, 51);
    for (let t = 0; t < 5; t++) {
      await h.turnTaking.receiveAudio(encodeMulaw(caller.subarray(t * FRAME, (t + 1) * FRAME)));
    }
    h.turnTaking.startSpeaking();
    h.upstream.length = 0;
    for (let t = 0; t < 60; t++) {
      h.turnTaking.retainReference(encodeMulaw(ref.subarray(t * FRAME, (t + 1) * FRAME)));
      await h.turnTaking.receiveAudio(encodeMulaw(caller.subarray((t + 5) * FRAME, (t + 6) * FRAME)));
    }
    assert.equal(h.decisions.length, 60);
    assert.equal(h.decisions.filter((decision) => decision.echo).length, 0);
    assert.equal(h.utterances.length, 0);
    assert.equal(h.bargeIns.length, 0);
    assert.equal(h.upstream.length, 0);
  });

  it('does not classify inbound frames while listening', async () => {
    const h = harness();
    await h.turnTaking.receiveAudio(encodeMulaw(voice(FRAME, 9)));
    assert.equal(h.decisions.length, 0);
    h.turnTaking.startSpeaking();
    await h.turnTaking.receiveAudio(encodeMulaw(voice(FRAME, 9)));
    assert.equal(h.decisions.length, 1);
  });
});
