import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CallStore } from '../src/calls.ts';
import { LiveCallSession } from '../src/live.ts';
import type { Vad } from '../src/endpoint.ts';
import type { Assistant, Transcriber, Transcription, TurnEvent } from '../src/app.ts';
import { greetingFor } from '../src/app.ts';
import type { RealtimeEndpointing, RealtimeStt, VadEvent } from '../src/sarvamRealtime.ts';
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

/** Scripted provider VAD channel: the provider owns boundaries in this suite. */
class FakeProviderStt implements RealtimeStt {
  endpointing: RealtimeEndpointing = 'vad';
  finalizeCalls = 0;
  speechStartCalls = 0;
  pushes = 0;
  private handler: ((event: VadEvent) => void) | null = null;
  private readonly finals: Transcription[];

  constructor(finals: Transcription[] = [{ text: 'what are your hours', noSpeech: false }]) {
    this.finals = finals;
  }

  pushAudio(): void {
    this.pushes += 1;
  }

  speechStart(): void {
    this.speechStartCalls += 1;
  }

  finalize(): Promise<Transcription> {
    const tx = this.finals[Math.min(this.finalizeCalls, this.finals.length - 1)]!;
    this.finalizeCalls += 1;
    return Promise.resolve(tx);
  }

  onVadEvent(handler: (event: VadEvent) => void): void {
    this.handler = handler;
  }

  emit(event: VadEvent): void {
    this.handler?.(event);
  }

  close(): void {}
}

class FailingFinalStt extends FakeProviderStt {
  override finalize(): Promise<Transcription> {
    this.finalizeCalls += 1;
    return Promise.reject(new Error('sarvam-realtime-final-timeout'));
  }
}

describe('live provider VAD boundaries', () => {
  it('answers from the provider end-of-turn plus its final, with no local fixed wait', async () => {
    const calls = new CallStore();
    const { tts, texts } = stubTts();
    const turns: TurnEvent[] = [];
    const realtime = new FakeProviderStt([{ text: 'what are your hours', noSpeech: false }]);
    let restCalls = 0;
    const transcriber: Transcriber = {
      transcribe: async () => {
        restCalls += 1;
        return { text: 'rest transcript', noSpeech: false };
      },
    };
    const live = new LiveCallSession({
      identity: { callSid: 'CApv1', streamSid: 'MZpv1' },
      sendAudio: () => {},
      // The local detector never latches: only the provider can end this Turn.
      vad: scriptVad(silence(400)),
      policy: POLICY,
      transcriber,
      realtime,
      turnDetection: 'sarvam',
      tts,
      guide: GUIDE,
      assistant,
      calls,
      logTurn: (e) => turns.push(e),
    });
    await feed(live, 100);
    assert.equal(turns.length, 0, 'no Turn before the provider says the Caller stopped');

    realtime.emit('speech_start');
    await feed(live, 30);
    realtime.emit('speech_end');
    await feed(live, 1);

    assert.equal(realtime.finalizeCalls, 1, 'the final is read from the live channel');
    assert.equal(realtime.speechStartCalls, 0, 'provider VAD mode sends no client boundary');
    assert.equal(restCalls, 0);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.excerpt, 'what are your hours');
    assert.match(turns[0]!.reply, /Monday to Friday/);
    assert.equal(calls.get('CApv1').history[0]!.text, 'what are your hours');
    assert.ok(texts.some((t) => /Monday to Friday/.test(t)));
    live.close('test');
  });

  it('captures the utterance audio across the provider boundary for fallback', async () => {
    const calls = new CallStore();
    const { tts } = stubTts();
    const realtime = new FakeProviderStt([{ text: 'hello', noSpeech: false }]);
    const utteranceLog: { bytes: number }[] = [];
    const live = new LiveCallSession({
      identity: { callSid: 'CApv2', streamSid: 'MZpv2' },
      sendAudio: () => {},
      vad: scriptVad(silence(400)),
      policy: POLICY,
      transcriber: { transcribe: async () => ({ text: 'rest', noSpeech: false }) },
      realtime,
      turnDetection: 'sarvam',
      tts,
      guide: GUIDE,
      assistant,
      calls,
      onUtteranceLog: (entry) => utteranceLog.push({ bytes: entry.bytes }),
    });
    // 30 frames of pre-roll precede speech_start; the 300 ms pre-roll window
    // keeps the last 15 of them so the first word is not clipped.
    await feed(live, 30);
    realtime.emit('speech_start');
    await feed(live, 20);
    realtime.emit('speech_end');
    await feed(live, 1);
    assert.equal(utteranceLog.length, 1);
    assert.equal(utteranceLog[0]!.bytes, (15 + 20) * FRAME_BYTES);
    live.close('test');
  });

  it('falls back to REST with the captured audio when the provider final fails', async () => {
    const calls = new CallStore();
    const { tts } = stubTts();
    const realtime = new FailingFinalStt();
    let restCalls = 0;
    const transcriber: Transcriber = {
      transcribe: async () => {
        restCalls += 1;
        return { text: 'rest transcript', noSpeech: false };
      },
    };
    const live = new LiveCallSession({
      identity: { callSid: 'CApv3', streamSid: 'MZpv3' },
      sendAudio: () => {},
      vad: scriptVad(silence(400)),
      policy: POLICY,
      transcriber,
      realtime,
      turnDetection: 'sarvam',
      tts,
      guide: GUIDE,
      assistant,
      calls,
    });
    realtime.emit('speech_start');
    await feed(live, 30);
    realtime.emit('speech_end');
    await feed(live, 1);
    assert.equal(realtime.finalizeCalls, 1);
    assert.equal(restCalls, 1);
    assert.equal(calls.get('CApv3').history[0]!.text, 'rest transcript');
    live.close('test');
  });

  it('cancels the no-response reprompt when the provider hears Caller speech', async () => {
    const calls = new CallStore();
    const { tts, texts } = stubTts();
    const realtime = new FakeProviderStt([{ text: 'hello', noSpeech: false }]);
    const live = new LiveCallSession({
      identity: { callSid: 'CApv4', streamSid: 'MZpv4' },
      sendAudio: () => {},
      vad: scriptVad(silence(400)),
      policy: POLICY,
      transcriber: { transcribe: async () => ({ text: '', noSpeech: true }) },
      realtime,
      turnDetection: 'sarvam',
      tts,
      guide: GUIDE,
      assistant,
      calls,
      noResponseMs: 40,
    });
    await live.open();
    await waitFor(() => texts.length === 1, 'the greeting');
    realtime.emit('speech_start');
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(texts.length, 1, 'the silent-call timer must not fire while the Caller speaks');
    realtime.emit('speech_end');
    await feed(live, 1);
    await waitFor(() => calls.get('CApv4').history.length >= 1, 'the Turn from the provider boundary');
    live.close('test');
  });

  it('still repeats then closes after two unanswered asks in provider mode', async () => {
    const calls = new CallStore();
    const { tts, texts } = stubTts();
    const realtime = new FakeProviderStt();
    let closed: string | null = null;
    const live = new LiveCallSession({
      identity: { callSid: 'CApv5', streamSid: 'MZpv5' },
      sendAudio: () => {},
      vad: scriptVad(silence(400)),
      policy: POLICY,
      transcriber: { transcribe: async () => ({ text: '', noSpeech: true }) },
      realtime,
      turnDetection: 'sarvam',
      tts,
      guide: GUIDE,
      calls,
      noResponseMs: 30,
      onClose: (reason) => {
        closed = reason;
      },
    });
    await live.open();
    await waitFor(() => closed !== null, 'the goodbye close');
    assert.equal(closed, 'goodbye');
    assert.equal(texts.length, 4);
    assert.equal(texts[0], greetingFor(GUIDE));
    assert.match(texts[1]!, /^Are you still there\?/);
    assert.match(texts[2]!, /^Are you still there\?/);
    assert.match(texts[3]!, /Goodbye/);
  });

  it('keeps local boundaries when the realtime channel stays manual', async () => {
    const calls = new CallStore();
    const { tts } = stubTts();
    const realtime = new FakeProviderStt([{ text: 'what are your hours', noSpeech: false }]);
    // Manual channel: it never announces provider boundaries.
    realtime.endpointing = 'manual';
    const live = new LiveCallSession({
      identity: { callSid: 'CApv6', streamSid: 'MZpv6' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: { transcribe: async () => ({ text: 'rest', noSpeech: false }) },
      realtime,
      turnDetection: 'sarvam',
      tts,
      guide: GUIDE,
      assistant,
      calls,
    });
    await feed(live, 100);
    assert.equal(realtime.speechStartCalls, 1, 'manual mode still opens the utterance client-side');
    assert.equal(realtime.finalizeCalls, 1);
    assert.equal(calls.get('CApv6').history[0]!.text, 'what are your hours');
    live.close('test');
  });

  it('keeps local boundaries when there is no realtime channel at all', async () => {
    const calls = new CallStore();
    const { tts } = stubTts();
    const live = new LiveCallSession({
      identity: { callSid: 'CApv7', streamSid: 'MZpv7' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: { transcribe: async () => ({ text: 'hello', noSpeech: false }) },
      turnDetection: 'sarvam',
      tts,
      guide: GUIDE,
      assistant,
      calls,
    });
    await feed(live, 100);
    assert.equal(calls.get('CApv7').history[0]!.text, 'hello');
    live.close('test');
  });
});
