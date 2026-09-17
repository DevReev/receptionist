import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeMulaw } from '../src/audio.ts';
import { TurnTaking } from '../src/turnTaking.ts';
import type { BargeInEvent, Utterance, Vad } from '../src/endpoint.ts';
import type { EchoDecision } from '../src/echoGate.ts';
import { echoFrame, voice } from './voiceFixtures.ts';

const FRAME = 160; // 20 ms of 8 kHz telephony
const POLICY = { silenceMs: 700, minSpeechMs: 300, maxUtteranceMs: 30000, threshold: 0.1, latchDipMs: 200 };

const scriptVad = (): Vad => ({ score: async () => 0.9, reset: () => {} });
const SILENCE_FRAME = Buffer.alloc(FRAME, 0xff);

interface Harness {
  turnTaking: TurnTaking;
  decisions: EchoDecision[];
  utterances: Utterance[];
  bargeIns: BargeInEvent[];
  upstream: Buffer[];
}

function harness(options?: { bargeInMinSpeechMs?: number }): Harness {
  const decisions: EchoDecision[] = [];
  const utterances: Utterance[] = [];
  const bargeIns: BargeInEvent[] = [];
  const upstream: Buffer[] = [];
  const turnTaking = new TurnTaking({
    vad: scriptVad(),
    policy: POLICY,
    detection: 'hybrid',
    bargeInMinSpeechMs: options?.bargeInMinSpeechMs,
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
  it('flags returned Echo and replaces it with mulaw silence upstream, without segmenting or stopping', async () => {
    const h = harness();
    const ref = voice(FRAME * 200, 3);
    for (let t = 0; t < 5; t++) {
      await h.turnTaking.receiveAudio(encodeMulaw(voice(FRAME, 90 + t)));
    }
    h.turnTaking.startSpeaking();
    h.upstream.length = 0;
    const fed: Buffer[] = [];
    let echoed = 0;
    for (let t = 0; t < 100; t++) {
      h.turnTaking.retainReference(encodeMulaw(ref.subarray(t * FRAME, (t + 1) * FRAME)));
      const inbound = encodeMulaw(echoFrame(ref, t, 960, 0.125));
      fed.push(inbound);
      await h.turnTaking.receiveAudio(inbound);
      if (t >= 7 && h.decisions[t]!.echo) echoed += 1;
    }
    assert.equal(h.decisions.length, 100);
    assert.ok(echoed >= 92, `echo frames flagged: ${echoed}/93`);
    assert.equal(h.utterances.length, 0);
    assert.equal(h.bargeIns.length, 0);
    // The whole call streams upstream: flagged Echo becomes silence, everything
    // else passes through untouched.
    assert.equal(h.upstream.length, 100);
    for (let t = 0; t < 100; t++) {
      if (h.decisions[t]!.echo) assert.deepEqual(h.upstream[t], SILENCE_FRAME);
      else assert.deepEqual(h.upstream[t], fed[t]);
    }
  });

  it('passes clean Caller speech upstream while the Receptionist speaks', async () => {
    // A high candidate threshold keeps this test on gate classification; the
    // fire-on-Caller-speech case lives in the barge-in suite.
    const h = harness({ bargeInMinSpeechMs: 60_000 });
    const ref = voice(FRAME * 100, 3);
    const caller = voice(FRAME * 100, 51);
    for (let t = 0; t < 5; t++) {
      await h.turnTaking.receiveAudio(encodeMulaw(caller.subarray(t * FRAME, (t + 1) * FRAME)));
    }
    h.turnTaking.startSpeaking();
    h.upstream.length = 0;
    const fed: Buffer[] = [];
    for (let t = 0; t < 60; t++) {
      h.turnTaking.retainReference(encodeMulaw(ref.subarray(t * FRAME, (t + 1) * FRAME)));
      const inbound = encodeMulaw(caller.subarray((t + 5) * FRAME, (t + 6) * FRAME));
      fed.push(inbound);
      await h.turnTaking.receiveAudio(inbound);
    }
    assert.equal(h.decisions.length, 60);
    assert.equal(h.decisions.filter((decision) => decision.echo).length, 0);
    assert.equal(h.utterances.length, 0);
    assert.equal(h.bargeIns.length, 0);
    assert.deepEqual(h.upstream, fed);
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
