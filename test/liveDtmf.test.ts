import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CallStore } from '../src/calls.ts';
import { LiveCallSession } from '../src/live.ts';
import type { Assistant, TurnEvent } from '../src/app.ts';
import type { Vad } from '../src/endpoint.ts';
import type { TraceEvent } from '../src/trace.ts';
import type { Tts } from '../src/tts.ts';

const POLICY = { silenceMs: 400, minSpeechMs: 300, maxUtteranceMs: 30000, threshold: 0.5, latchDipMs: 200 };
const GUIDE = { raw: '# Clinic Guide — Maple Clinic\n', name: 'Maple Clinic' };

function silentVad(): Vad {
  return { score: async () => 0.05, reset: () => {} };
}

interface HarnessOptions {
  assistant?: Assistant;
  tts?: Tts;
  logTurn?: (event: TurnEvent) => void;
}

function harness(
  callSid: string,
  opts: HarnessOptions = {},
): { live: LiveCallSession; calls: CallStore; traces: TraceEvent[] } {
  const calls = new CallStore();
  const traces: TraceEvent[] = [];
  const tts: Tts = opts.tts ?? { synthesize: async () => ({ audio: Buffer.from([0xff]) }) };
  const live = new LiveCallSession({
    identity: { callSid, streamSid: `MZ${callSid}` },
    sendAudio: () => {},
    vad: silentVad(),
    policy: POLICY,
    transcriber: { transcribe: async () => ({ text: '', noSpeech: true }) },
    tts,
    guide: GUIDE,
    assistant: opts.assistant,
    calls,
    trace: (e) => traces.push(e),
    logTurn: opts.logTurn,
  });
  return { live, calls, traces };
}

/** Assistant that answers any Turn with one short reply. */
function replyAssistant(): Assistant {
  return {
    reply: async () => ({ text: '', endCall: false }),
    replyStream: async function* () {
      yield 'Got your number.';
    },
  };
}

function press(live: LiveCallSession, keys: string): void {
  for (const digit of keys) live.receiveDtmf(digit);
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
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

  it('runs the keyed number through the same Turn path as speech', async () => {
    const turns: TurnEvent[] = [];
    const h = harness('CAdtmf5', { assistant: replyAssistant(), logTurn: (e) => turns.push(e) });
    h.calls.get('CAdtmf5').misses = 2;
    press(h.live, '9876543210#');
    await h.live.flush();
    assert.equal(h.calls.get('CAdtmf5').turn, 1);
    assert.equal(h.calls.get('CAdtmf5').misses, 0, 'the successful keyed Turn clears the miss streak');
    assert.equal(turns.length, 1, 'the keyed Turn emits a Turn event');
    assert.equal(turns[0]!.excerpt, 'my number is 9876543210');
    assert.equal(turns[0]!.reply, 'Got your number.');
    assert.equal(turns[0]!.miss, false);
  });

  it('captures the keyed Turn reply so a close mid-reply still logs it', async () => {
    const turns: TurnEvent[] = [];
    const synthesized: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tts: Tts = {
      synthesize: async (text: string) => {
        synthesized.push(text);
        if (text.includes('Got')) await gate;
        return { audio: Buffer.from([0xff]) };
      },
    };
    const h = harness('CAdtmf6', { assistant: replyAssistant(), tts, logTurn: (e) => turns.push(e) });
    press(h.live, '9876543210#');
    // Wait until the reply text has been captured on the active Turn and its
    // synthesis has started, then hang up before the audio finishes.
    await waitFor(() => synthesized.length > 0, 'the reply to reach TTS');
    h.live.close('hangup');
    release();
    await h.live.flush();
    assert.equal(turns.length, 1, 'the closed Turn is drained with its captured reply');
    assert.equal(turns[0]!.excerpt, 'my number is 9876543210');
    assert.equal(turns[0]!.reply, 'Got your number.');
    assert.equal(turns[0]!.endCall, true);
  });

  it('opens the keyed Turn only after the in-flight Turn settles', async () => {
    const turns: TurnEvent[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tts: Tts = {
      synthesize: async (text: string) => {
        if (text.includes('First')) await gate;
        return { audio: Buffer.from([0xff]) };
      },
    };
    const assistant: Assistant = {
      reply: async () => ({ text: '', endCall: false }),
      replyStream: async function* (ctx) {
        yield ctx.transcript.includes('1111111111') ? 'First reply.' : 'Second reply.';
      },
    };
    const h = harness('CAdtmf7', { assistant, tts, logTurn: (e) => turns.push(e) });
    press(h.live, '1111111111#');
    await waitFor(() => h.live.currentPhase === 'SPEAKING', 'the first keyed reply to start');
    // `#` lands while the first reply is still playing. The keyed Turn must
    // queue behind it instead of re-pointing the active Turn's reply capture.
    press(h.live, '2222222222#');
    assert.equal(h.calls.get('CAdtmf7').turn, 1, 'the queued keyed Turn has not opened yet');
    release();
    await h.live.flush();
    assert.equal(h.calls.get('CAdtmf7').turn, 2);
    assert.equal(turns.length, 2, 'both Turns are logged, not merged');
    assert.equal(turns[0]!.turn, 1);
    assert.equal(turns[0]!.reply, 'First reply.');
    assert.equal(turns[1]!.turn, 2);
    assert.equal(turns[1]!.reply, 'Second reply.');
  });
});
