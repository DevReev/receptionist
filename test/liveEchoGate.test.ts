import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeMulaw } from '../src/audio.ts';
import { CallStore } from '../src/calls.ts';
import { LiveCallSession } from '../src/live.ts';
import type { Vad } from '../src/endpoint.ts';
import type { Tts } from '../src/tts.ts';
import type { TraceEvent } from '../src/trace.ts';

const FRAME = 160;
const POLICY = { silenceMs: 700, minSpeechMs: 300, maxUtteranceMs: 30000, threshold: 0.5, latchDipMs: 200 };

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

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('live echo gate trace', () => {
  it('records each gate decision with the evidence used', async () => {
    const traces: TraceEvent[] = [];
    const vad: Vad = { score: async () => 0.9, reset: () => {} };
    const tts: Tts = { synthesize: async () => ({ audio: Buffer.alloc(FRAME, 0xff) }) };
    const live = new LiveCallSession({
      identity: { callSid: 'CAgate', streamSid: 'MZgate' },
      sendAudio: () => {},
      vad,
      policy: POLICY,
      transcriber: { transcribe: async () => ({ text: '', noSpeech: true }) },
      tts,
      guide: { raw: '# Guide\n', name: 'Gate Clinic' },
      calls: new CallStore(),
      trace: (event) => traces.push(event),
      // Hold the greeting in SPEAKING while the Echo returns.
      finishPlayback: () => new Promise(() => {}),
    });
    void live.open().catch(() => {});
    await waitFor(() => live.currentPhase === 'SPEAKING', 'the greeting to start');
    const ref = voice(FRAME * 40, 5);
    for (let t = 0; t < 30; t++) {
      live.retainReference(encodeMulaw(ref.subarray(t * FRAME, (t + 1) * FRAME)));
      await live.receiveAudio(encodeMulaw(echoFrame(ref, t, 240, 0.125)));
    }
    const decisions = traces.filter((event) => event.component === 'echo-gate' && event.event === 'decision');
    assert.ok(decisions.length >= 25, `decisions ${decisions.length}`);
    assert.equal(decisions.length, 30);
    const echoes = decisions.filter((event) => event.echo === true);
    assert.ok(echoes.length >= 25, `echo decisions ${echoes.length}`);
    for (const decision of echoes) {
      assert.equal(decision.reason, 'echo');
      assert.equal(typeof decision.correlation, 'number');
      assert.equal(typeof decision.delayMs, 'number');
      assert.equal(typeof decision.inboundRms, 'number');
      assert.equal(typeof decision.referenceRms, 'number');
      assert.equal(typeof decision.returnLossDb, 'number');
      assert.equal(decision.threshold, 0.7);
      assert.equal(decision.marginDb, 6);
    }
    live.close('test');
  });
});
