import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CallStore } from '../src/calls.ts';
import { LiveCallSession } from '../src/live.ts';
import { EMERGENCY_LINE } from '../src/dialogue.ts';
import type { Vad } from '../src/endpoint.ts';
import type { Assistant, Transcription } from '../src/app.ts';
import type { PlaybackResult } from '../src/transport.ts';
import type { Tts } from '../src/tts.ts';
import { FRAME_BYTES, SPEECH_FRAME } from './fakeStream.ts';

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
  const deadline = Date.now() + 3000;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function queueTranscriber(texts: string[]): { transcribe: () => Promise<Transcription> } {
  let n = 0;
  return {
    transcribe: async () => {
      const text = texts[Math.min(n, texts.length - 1)] ?? '';
      n += 1;
      return { text, noSpeech: false };
    },
  };
}

describe('fixed-response generation guard (ticket 05)', () => {
  it('plays two fixed responses back-to-back in order without truncation', async () => {
    const calls = new CallStore();
    const audio: Buffer[] = [];
    const texts: string[] = [];
    const completions: string[] = [];
    const tts: Tts = {
      synthesize: async (text: string) => {
        texts.push(text);
        return { audio: Buffer.from(text) };
      },
    };
    const live = new LiveCallSession({
      identity: { callSid: 'CAfixed2', streamSid: 'MZfixed2' },
      sendAudio: (b) => audio.push(b),
      vad: scriptVad(silence(5)),
      policy: POLICY,
      transcriber: queueTranscriber(['']),
      tts,
      guide: GUIDE,
      calls,
      finishPlayback: async () => ({ outcome: 'played', mark: '' }),
      onPlaybackComplete: (t) => completions.push(t),
    });
    const p1 = live.speakFixed('First fixed line.');
    const p2 = live.speakFixed('Second fixed line.');
    await Promise.all([p1, p2]);
    assert.deepEqual(texts, ['First fixed line.', 'Second fixed line.']);
    assert.deepEqual(
      audio.map((b) => b.toString()),
      ['First fixed line.', 'Second fixed line.'],
    );
    assert.deepEqual(completions, ['First fixed line.', 'Second fixed line.']);
    live.close('test');
  });

  it('a fixed response interrupted by barge-in stops and never enters history', async () => {
    const calls = new CallStore();
    const audio: Buffer[] = [];
    const completions: string[] = [];
    let cleared = 0;
    let resolveFinish: ((result: PlaybackResult) => void) | null = null;
    let releaseSecond: (() => void) | null = null;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const tts: Tts = {
      synthesize: async (text: string) => ({ audio: Buffer.from([0x09, text.length % 256]) }),
      synthesizeStream: async function* (text: string) {
        if (text.includes('emergency')) {
          yield Buffer.from([0x01]);
          await secondGate;
          yield Buffer.from([0x02]);
        } else {
          yield Buffer.from([0x03]);
        }
      },
    };
    const assistant: Assistant = {
      reply: async () => ({ text: '', endCall: false }),
      replyStream: async function* () {
        yield 'Alright. ';
      },
    };
    const live = new LiveCallSession({
      identity: { callSid: 'CAfixedbarge', streamSid: 'MZfixedbarge' },
      sendAudio: (b) => audio.push(b),
      vad: scriptVad([...speech(50), ...silence(50), ...speech(20), ...silence(100)]),
      policy: POLICY,
      transcriber: queueTranscriber(['I have chest pain', 'never mind']),
      tts,
      guide: GUIDE,
      assistant,
      calls,
      bargeInMinSpeechMs: 200,
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
      onPlaybackComplete: (t) => completions.push(t),
    });

    const firstFeed = (async () => {
      for (let i = 0; i < 100; i++) await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
      await live.flush();
    })();
    await waitFor(() => live.currentPhase === 'SPEAKING', 'the fixed reply to start');
    await waitFor(() => audio.length >= 1, 'the first fixed chunk to play');
    for (let i = 0; i < 20; i++) await live.receiveAudio(SPEECH_FRAME);
    await waitFor(() => cleared === 1, 'the barge-in to clear the fixed reply');
    releaseSecond!();
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 50; i++) await live.receiveAudio(SPEECH_FRAME);
    await live.flush();
    await firstFeed;
    await waitFor(() => calls.get('CAfixedbarge').turn === 2, 'the interruption Turn');

    assert.equal(cleared, 1);
    assert.ok(
      audio.every((b) => !b.equals(Buffer.from([0x02]))),
      'the second fixed chunk never plays after barge-in',
    );
    assert.ok(
      completions.every((t) => t !== EMERGENCY_LINE),
      'the interrupted fixed reply never completes playback',
    );
    const history = calls.get('CAfixedbarge').history;
    assert.ok(
      history.some((h) => h.role === 'caller' && h.text.includes('chest pain')),
      'the caller turn is kept',
    );
    assert.equal(
      history.some((h) => h.role === 'receptionist' && h.text.includes('emergency')),
      false,
      'the interrupted fixed reply never enters history',
    );
    live.close('test');
  });
});
