import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CallStore } from '../src/calls.ts';
import { LiveCallSession } from '../src/live.ts';
import type { Vad } from '../src/endpoint.ts';
import type { TraceEvent } from '../src/trace.ts';
import type { Tts } from '../src/tts.ts';

const POLICY = { silenceMs: 400, minSpeechMs: 300, maxUtteranceMs: 30000, threshold: 0.5, latchDipMs: 200 };
const GUIDE = { raw: '# Clinic Guide — Maple Clinic\n', name: 'Maple Clinic' };

function silentVad(): Vad {
  return { score: async () => 0.05, reset: () => {} };
}

function harness(callSid: string): { live: LiveCallSession; calls: CallStore; traces: TraceEvent[] } {
  const calls = new CallStore();
  const traces: TraceEvent[] = [];
  const tts: Tts = { synthesize: async () => ({ audio: Buffer.from([0xff]) }) };
  const live = new LiveCallSession({
    identity: { callSid, streamSid: `MZ${callSid}` },
    sendAudio: () => {},
    vad: silentVad(),
    policy: POLICY,
    transcriber: { transcribe: async () => ({ text: '', noSpeech: true }) },
    tts,
    guide: GUIDE,
    calls,
    trace: (e) => traces.push(e),
  });
  return { live, calls, traces };
}

function press(live: LiveCallSession, keys: string): void {
  for (const digit of keys) live.receiveDtmf(digit);
}

describe('live DTMF phone entry', () => {
  it('stores keypad digits as the patient phone when # submits', async () => {
    const h = harness('CAdtmf1');
    press(h.live, '9876543210#');
    await h.live.flush();
    assert.equal(h.live.state.patient.phone, '9876543210');
    assert.equal(h.live.state.patient.phoneSource, 'spoken');
    assert.deepEqual(
      h.calls.get('CAdtmf1').history.map((entry) => entry.text),
      ['my number is 9876543210'],
    );
  });

  it('clears digits pressed so far when * is pressed', async () => {
    const h = harness('CAdtmf2');
    press(h.live, '123*9876543210#');
    await h.live.flush();
    assert.equal(h.live.state.patient.phone, '9876543210');
  });

  it('ignores a submit that is not a full number', async () => {
    const h = harness('CAdtmf3');
    press(h.live, '123#');
    await h.live.flush();
    assert.equal(h.live.state.patient.phone, undefined);
    assert.equal(h.calls.get('CAdtmf3').history.length, 0);
    assert.equal(h.calls.get('CAdtmf3').turn, 0);
  });

  it('never traces the digits themselves', async () => {
    const h = harness('CAdtmf4');
    press(h.live, '9876543210#');
    await h.live.flush();
    const serialized = JSON.stringify(h.traces);
    assert.ok(!serialized.includes('9876543210'), serialized);
    assert.ok(serialized.includes('dtmf-submit'), serialized);
  });
});
