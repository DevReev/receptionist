import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EchoGate } from '../src/echoGate.ts';
import { encodeMulaw } from '../src/audio.ts';
import { echoFrame, voice } from './voiceFixtures.ts';

const FRAME = 160; // 20 ms of 8 kHz telephony
const SILENCE = encodeMulaw(new Int16Array(FRAME));

/** Sample-wise sum of a Caller frame and an Echo frame, in PCM. */
function sum(a: Int16Array, b: Int16Array): Int16Array {
  const out = new Int16Array(FRAME);
  for (let i = 0; i < FRAME; i++) {
    out[i] = Math.max(-32768, Math.min(32767, a[i]! + b[i]!));
  }
  return out;
}

function frames(pcm: Int16Array): Int16Array[] {
  const out: Int16Array[] = [];
  for (let offset = 0; offset < pcm.length; offset += FRAME) out.push(pcm.subarray(offset, offset + FRAME));
  return out;
}

describe('echo gate', () => {
  it('flags the attenuated, delayed reference as Echo with correlation and return-loss evidence', () => {
    const ref = voice(FRAME * 40, 3);
    const gate = new EchoGate();
    let echoFrames = 0;
    let learnedLoss: number | null = null;
    for (let t = 0; t < 30; t++) {
      gate.pushReference(encodeMulaw(frames(ref)[t] ?? new Int16Array(FRAME)));
      const decision = gate.classify(echoFrame(ref, t, 320, 0.125));
      if (t >= 5) {
        assert.equal(decision.echo, true, `frame ${t} must be Echo (${decision.reason})`);
        echoFrames += 1;
        assert.equal(decision.reason, 'echo');
        assert.ok(decision.evidence.correlation > 0.8, `correlation ${decision.evidence.correlation}`);
        assert.ok(Math.abs(decision.evidence.delayMs - 40) <= 5, `delay ${decision.evidence.delayMs}ms`);
        learnedLoss = decision.evidence.returnLossDb;
      }
    }
    assert.equal(echoFrames, 25);
    assert.ok(learnedLoss !== null && Math.abs(learnedLoss + 18) <= 3, `return loss ${learnedLoss}dB`);
    assert.ok(Math.abs(gate.returnLossDb! + 18) <= 3);
  });

  it('passes Caller speech while the reference is silent', () => {
    const ref = new Int16Array(FRAME * 10);
    const gate = new EchoGate();
    for (let t = 0; t < 10; t++) {
      gate.pushReference(encodeMulaw(ref.subarray(t * FRAME, (t + 1) * FRAME)));
      const decision = gate.classify(voice(FRAME, 99));
      assert.equal(decision.echo, false, `frame ${t} must pass (${decision.reason})`);
    }
    assert.equal(gate.returnLossDb, null);
  });

  it('passes a frame whose energy cannot be explained by the reference', () => {
    const ref = new Int16Array(FRAME); // one frame of silence pushed; no reference energy
    const gate = new EchoGate();
    gate.pushReference(encodeMulaw(ref));
    const decision = gate.classify(voice(FRAME, 7));
    assert.equal(decision.echo, false);
    assert.ok(['no-reference', 'uncorrelated'].includes(decision.reason));
    assert.ok(decision.evidence.inboundRms > 100);
  });

  it('classifies digital silence as silence, never Echo', () => {
    const gate = new EchoGate();
    for (let t = 0; t < 5; t++) gate.pushReference(encodeMulaw(voice(FRAME, 2)));
    const decision = gate.classify(new Int16Array(FRAME));
    assert.equal(decision.echo, false);
    assert.equal(decision.reason, 'silence');
  });

  it('passes double-talk: Caller speech over its own quiet returning Echo', () => {
    const ref = voice(FRAME * 40, 3);
    const caller = voice(FRAME * 40, 11);
    const gate = new EchoGate();
    for (let t = 0; t < 30; t++) {
      gate.pushReference(encodeMulaw(frames(ref)[t] ?? new Int16Array(FRAME)));
      const echo = echoFrame(ref, t, 200, 0.125);
      const inbound = t < 6 ? echo : sum(caller.subarray(t * FRAME, (t + 1) * FRAME), echo);
      const decision = gate.classify(inbound);
      if (t < 6) continue;
      assert.equal(decision.echo, false, `double-talk frame ${t} must pass (${decision.reason})`);
    }
  });

  it('tracks a changed echo delay', () => {
    const ref = voice(FRAME * 60, 5);
    const gate = new EchoGate();
    let first: number | null = null;
    let second: number | null = null;
    for (let t = 0; t < 50; t++) {
      gate.pushReference(encodeMulaw(frames(ref)[t] ?? new Int16Array(FRAME)));
      const delaySamples = t < 25 ? 80 : 400;
      const decision = gate.classify(echoFrame(ref, t, delaySamples, 0.25));
      if (t === 10) first = decision.evidence.delayMs;
      if (t === 40) second = decision.evidence.delayMs;
    }
    assert.ok(first !== null && Math.abs(first - 10) <= 5, `first delay ${first}ms`);
    assert.ok(second !== null && Math.abs(second - 50) <= 5, `second delay ${second}ms`);
  });

  it('recovers after a gap of silence between Echo bursts', () => {
    const ref = voice(FRAME * 40, 3);
    const gate = new EchoGate();
    for (let t = 0; t < 10; t++) {
      gate.pushReference(encodeMulaw(frames(ref)[t]!));
      if (t < 2) continue;
      assert.equal(gate.classify(echoFrame(ref, t, 320, 0.125)).echo, true);
    }
    for (let t = 10; t < 20; t++) {
      gate.pushReference(encodeMulaw(frames(ref)[t]!));
      assert.equal(gate.classify(new Int16Array(FRAME)).echo, false);
    }
    for (let t = 20; t < 30; t++) {
      gate.pushReference(encodeMulaw(frames(ref)[t]!));
      assert.equal(gate.classify(echoFrame(ref, t, 320, 0.125)).echo, true, `burst frame ${t}`);
    }
  });

  it('flags the first Echo frame after silence, before the window fills with it', () => {
    const ref = voice(FRAME * 40, 3);
    const gate = new EchoGate();
    for (let t = 0; t < 4; t++) {
      gate.pushReference(encodeMulaw(frames(ref)[t]!));
      gate.classify(new Int16Array(FRAME));
    }
    // Echo of frame 2 lands at t=4, with a tail of silence in the window.
    for (let t = 4; t < 10; t++) {
      gate.pushReference(encodeMulaw(frames(ref)[t]!));
      assert.equal(gate.classify(echoFrame(ref, t, 320, 0.125)).echo, true, `burst frame ${t}`);
    }
  });

  it('re-learns the return level when the echo path gets louder', () => {
    const ref = voice(FRAME * 60, 3);
    const gate = new EchoGate();
    for (let t = 0; t < 30; t++) {
      gate.pushReference(encodeMulaw(frames(ref)[t]!));
      if (t >= 2) assert.equal(gate.classify(echoFrame(ref, t, 320, 0.125)).echo, true, `quiet frame ${t}`);
      else gate.classify(echoFrame(ref, t, 320, 0.125));
    }
    assert.ok(Math.abs(gate.returnLossDb! + 18) <= 3, `learned ${gate.returnLossDb}dB`);
    // The Caller switches to speakerphone: the return jumps to about -3 dB.
    // The two frames that straddle the jump are level-mixed, then the gate
    // re-locks on the new return and re-learns the loss.
    for (let t = 30; t < 55; t++) {
      gate.pushReference(encodeMulaw(frames(ref)[t]!));
      const decision = gate.classify(echoFrame(ref, t, 320, 0.7));
      if (t >= 32) assert.equal(decision.echo, true, `loud frame ${t}`);
    }
    assert.ok(Math.abs(gate.returnLossDb! + 3) <= 3, `re-learned ${gate.returnLossDb}dB`);
  });
});
