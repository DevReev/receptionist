import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CallStore } from '../src/calls.ts';
import { LiveCallSession } from '../src/live.ts';
import type { Vad } from '../src/endpoint.ts';
import type { Assistant, FailureEvent, Transcription, TurnEvent } from '../src/app.ts';
import type { PlaybackResult } from '../src/transport.ts';
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

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function queueTranscriber(texts: string[]): { transcribe: (a: Buffer, c: string) => Promise<Transcription> } {
  let n = 0;
  return {
    transcribe: async () => {
      const text = texts[Math.min(n, texts.length - 1)] ?? '';
      n += 1;
      return { text, noSpeech: false };
    },
  };
}

describe('live barge-in', () => {
  it('clears audible speech, drops unheard wording, and keeps the interruption as one new Turn', async () => {
    const calls = new CallStore();
    const texts: string[] = [];
    const turns: TurnEvent[] = [];
    const failures: FailureEvent[] = [];
    let cleared = 0;
    let resolveFinish: ((result: PlaybackResult) => void) | null = null;
    const tts: Tts = {
      synthesize: async (text: string) => {
        texts.push(text);
        return { audio: Buffer.from([0x01]) };
      },
    };
    let replyIndex = 0;
    const assistant: Assistant = {
      reply: async () => ({ text: '', endCall: false }),
      replyStream: async function* () {
        replyIndex += 1;
        yield replyIndex === 1
          ? 'This is a very long reply that the caller will interrupt before hearing. '
          : 'We are open Monday to Friday. ';
      },
    };
    const live = new LiveCallSession({
      identity: { callSid: 'CAbarge', streamSid: 'MZbarge' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50), ...speech(20), ...silence(100)]),
      policy: POLICY,
      transcriber: queueTranscriber(['hello', 'book Wednesday']),
      tts,
      guide: GUIDE,
      assistant,
      calls,
      bargeIn: true,
      interruptionMs: 200,
      finishPlayback: () =>
        cleared === 0
          ? new Promise<PlaybackResult>((resolve) => {
              resolveFinish = resolve;
            })
          : Promise.resolve({ outcome: 'played', mark: '' }),
      clearPlayback: (reason) => {
        cleared += 1;
        resolveFinish?.({ outcome: 'cleared', mark: '', reason });
      },
      logTurn: (e) => turns.push(e),
      logFailure: (e) => failures.push(e),
    });

    const firstFeed = (async () => {
      for (let i = 0; i < 100; i++) await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
      await live.flush();
    })();
    await waitFor(() => live.currentPhase === 'SPEAKING', 'the reply to start');
    // Sustained Caller speech while the Receptionist speaks.
    for (let i = 0; i < 20; i++) await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
    await waitFor(() => cleared === 1, 'the barge-in candidate to fire');
    assert.equal(live.currentPhase, 'LISTENING');
    // The retained candidate continues into the next utterance.
    for (let i = 0; i < 50; i++) await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
    await live.flush();
    await firstFeed;
    await waitFor(() => calls.get('CAbarge').turn === 2, 'exactly one promoted Turn');

    assert.equal(cleared, 1, 'clear is sent once for the barge-in');
    assert.equal(calls.get('CAbarge').turn, 2, 'the interruption becomes one new Turn, not two');
    const history = calls.get('CAbarge').history;
    assert.equal(
      history.some((h) => h.text.includes('very long reply')),
      false,
      'unheard assistant text never enters history',
    );
    assert.equal(
      turns.some((t) => t.excerpt === 'hello' && t.reply.includes('very long reply')),
      false,
      'the interrupted reply is not logged as spoken',
    );
    assert.equal(failures.length, 0);
    assert.equal(live.isClosed, false);
    live.close('test');
  });

  it('does not trigger on brief backchannels or noise during playback', async () => {
    const calls = new CallStore();
    const texts: string[] = [];
    const tts: Tts = {
      synthesize: async (text: string) => {
        texts.push(text);
        return { audio: Buffer.from([0x01]) };
      },
    };
    let cleared = 0;
    let resolveFinish: ((result: PlaybackResult) => void) | null = null;
    const live = new LiveCallSession({
      identity: { callSid: 'CAnoise', streamSid: 'MZnoise' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50), ...speech(5), ...silence(100)]),
      policy: POLICY,
      transcriber: queueTranscriber(['hello']),
      tts,
      guide: GUIDE,
      assistant: {
        reply: async () => ({ text: '', endCall: false }),
        replyStream: async function* () {
          yield 'Here is a longer answer for the caller. ';
        },
      },
      calls,
      bargeIn: true,
      interruptionMs: 200,
      finishPlayback: () =>
        new Promise<PlaybackResult>((resolve) => {
          resolveFinish = resolve;
        }),
      clearPlayback: () => {
        cleared += 1;
      },
      onPlaybackComplete: () => {},
    });
    const firstFeed = (async () => {
      for (let i = 0; i < 100; i++) await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
      await live.flush();
    })();
    await waitFor(() => live.currentPhase === 'SPEAKING', 'the reply to start');
    // 100 ms of noise: below the 200 ms interruption threshold.
    for (let i = 0; i < 5; i++) await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
    for (let i = 0; i < 20; i++) await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
    assert.equal(cleared, 0, 'brief noise never interrupts');
    assert.equal(live.currentPhase, 'SPEAKING');
    (resolveFinish as ((result: PlaybackResult) => void) | null)?.({ outcome: 'played', mark: '' });
    await firstFeed;
    assert.ok(texts.some((t) => t.includes('longer answer')));
    live.close('test');
  });
});
