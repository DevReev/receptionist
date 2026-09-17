import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CallStore } from '../src/calls.ts';
import { LiveCallSession } from '../src/live.ts';
import type { Vad } from '../src/endpoint.ts';
import type { Assistant, FailureEvent, TurnEvent } from '../src/app.ts';
import { greetingFor } from '../src/app.ts';
import type { Tts } from '../src/tts.ts';

const FRAME_BYTES = 160;
const POLICY = { silenceMs: 700, minSpeechMs: 300, maxUtteranceMs: 30000, threshold: 0.5, latchDipMs: 200 };
const GUIDE = { raw: '# Clinic Guide — Maple Clinic\n', name: 'Maple Clinic' };

function scriptVad(pattern: ('speech' | 'silence')[]): Vad {
  let calls = 0;
  return {
    score: async () => {
      calls += 1;
      return pattern[Math.min(calls - 1, pattern.length - 1)] === 'speech' ? 0.9 : 0.05;
    },
    reset: () => {},
  };
}

const speech = (n: number): ('speech' | 'silence')[] => Array(n).fill('speech');
const silence = (n: number): ('speech' | 'silence')[] => Array(n).fill('silence');

function stubTts() {
  const texts: string[] = [];
  const tts: Tts = {
    synthesize: async (text: string) => {
      texts.push(text);
      return { audio: Buffer.from([0xff]) };
    },
  };
  return { tts, texts };
}

const assistant: Assistant = {
  reply: async () => ({ text: '', endCall: false }),
  replyStream: async function* () {
    yield 'We are open Monday to Friday. ';
  },
};

async function feed(live: LiveCallSession, frames: number): Promise<void> {
  for (let i = 0; i < frames; i++) {
    await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
  }
  await live.flush();
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('live no-response reprompt', () => {
  it('asks again with the last question when the caller stays silent', async () => {
    const calls = new CallStore();
    const { tts, texts } = stubTts();
    const turns: TurnEvent[] = [];
    const live = new LiveCallSession({
      identity: { callSid: 'CAnr1', streamSid: 'MZnr1' },
      sendAudio: () => {},
      vad: scriptVad(silence(100)),
      policy: POLICY,
      transcriber: { transcribe: async () => ({ text: '', noSpeech: true }) },
      tts,
      guide: GUIDE,
      calls,
      noResponseMs: 30,
      logTurn: (e) => turns.push(e),
    });
    await live.open();
    await waitFor(() => texts.length >= 2, 'the ask-again line');
    assert.equal(texts[0], greetingFor(GUIDE));
    assert.equal(texts[1], 'Are you still there? How can I help you today?');
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.excerpt, '');
    assert.equal(turns[0]!.reply, texts[1]);
    assert.equal(turns[0]!.miss, true);
    assert.equal(turns[0]!.endCall, false);
    live.close('test');
  });

  it('resets the ask count once the caller speaks', async () => {
    const calls = new CallStore();
    const { tts, texts } = stubTts();
    let closed: string | null = null;
    const live = new LiveCallSession({
      identity: { callSid: 'CAnr2', streamSid: 'MZnr2' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: { transcribe: async () => ({ text: 'hello', noSpeech: false }) },
      tts,
      guide: GUIDE,
      assistant,
      calls,
      noResponseMs: 40,
      onClose: (reason) => {
        closed = reason;
      },
    });
    await live.open();
    await waitFor(() => texts.length >= 3, 'two unanswered asks');
    await feed(live, 100);
    assert.equal(calls.get('CAnr2').history[0]!.text, 'hello');
    await waitFor(() => texts.length >= 6, 'two more asks after the caller spoke');
    assert.equal(closed, null, 'the count restarts after speech, so no goodbye yet');
    assert.match(texts[5]!, /^Are you still there\?/);
    live.close('test');
  });

  it('says goodbye and closes after two unanswered asks', async () => {
    const calls = new CallStore();
    const { tts, texts } = stubTts();
    const turns: TurnEvent[] = [];
    const failures: FailureEvent[] = [];
    let closed: string | null = null;
    const live = new LiveCallSession({
      identity: { callSid: 'CAnr3', streamSid: 'MZnr3' },
      sendAudio: () => {},
      vad: scriptVad(silence(100)),
      policy: POLICY,
      transcriber: { transcribe: async () => ({ text: '', noSpeech: true }) },
      tts,
      guide: GUIDE,
      calls,
      noResponseMs: 30,
      logTurn: (e) => turns.push(e),
      logFailure: (e) => failures.push(e),
      onClose: (reason) => {
        closed = reason;
      },
    });
    await live.open();
    await waitFor(() => closed !== null, 'the goodbye close');
    assert.equal(closed, 'goodbye');
    assert.equal(texts.length, 4);
    assert.match(texts[3]!, /Goodbye/);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.detail, 'no-response');
    assert.equal(failures[0]!.reason, 'low-confidence');
    assert.equal(turns.length, 3);
    assert.equal(turns[2]!.endCall, true);
    assert.equal(turns[2]!.reply, texts[3]);
  });
});
