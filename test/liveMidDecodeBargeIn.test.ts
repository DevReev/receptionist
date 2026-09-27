import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Transcription, TurnEvent } from '../src/app.ts';
import { CallStore } from '../src/calls.ts';
import { LiveCallSession } from '../src/live.ts';
import type { Tts } from '../src/tts.ts';
import { FRAME_BYTES, SPEECH_FRAME, SILENCE_FRAME, byteVad } from './fakeStream.ts';

const POLICY = { silenceMs: 400, minSpeechMs: 300, maxUtteranceMs: 30000, threshold: 0.5, latchDipMs: 200 };
const GUIDE = { raw: '# Clinic Guide — Maple Clinic\n', name: 'Maple Clinic' };

function stubTts(): { tts: Tts; texts: string[] } {
  const texts: string[] = [];
  const tts: Tts = {
    synthesize: async (text: string) => {
      texts.push(text);
      return { audio: Buffer.from([0x01]) };
    },
  };
  return { tts, texts };
}

async function waitFor(cond: () => boolean, what: string, budgetMs = 3000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function feed(live: LiveCallSession, frame: Buffer, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await live.receiveAudio(frame);
}

describe('mid-decode barge-in audio path (ticket 16)', () => {
  it('scripted speech over a hung decode aborts it; late transcript never lands; speech becomes the next Turn', async () => {
    const calls = new CallStore();
    const { tts, texts } = stubTts();
    const turns: TurnEvent[] = [];
    let count = 0;
    const signals: AbortSignal[] = [];
    let releaseLate!: (tx: Transcription) => void;
    const lateGate = new Promise<Transcription>((resolve) => {
      releaseLate = resolve;
    });
    const live = new LiveCallSession({
      identity: { callSid: 'CAmiddecode', streamSid: 'MZmiddecode' },
      sendAudio: () => {},
      vad: byteVad,
      policy: POLICY,
      transcriber: {
        transcribe: (_audio, _contentType, signal) => {
          count += 1;
          if (signal) signals.push(signal);
          if (count === 1) return lateGate;
          return Promise.resolve({ text: 'second turn words', noSpeech: false });
        },
      },
      tts,
      guide: GUIDE,
      calls,
      bargeInMinSpeechMs: 200,
      transcribeDeadlineMs: 10_000,
      logTurn: (e) => turns.push(e),
    });

    // First utterance: speech latches, silence endpoints it into transcription.
    await feed(live, SPEECH_FRAME, 50);
    await feed(live, SILENCE_FRAME, 30);
    await waitFor(() => count === 1, 'the hung decode to start');

    // Interrupt mid-decode through the audio path (no direct handleBargeIn).
    const interruptStart = Date.now();
    await feed(live, SPEECH_FRAME, 12);
    await waitFor(() => signals[0]!.aborted, 'the audio-path barge-in to abort the decode');
    const stopMs = Date.now() - interruptStart;
    assert.equal(live.currentPhase, 'LISTENING', 'the session returns to listening after the abort');

    // The provider ignores the abort and resolves late anyway.
    releaseLate({ text: 'late words', noSpeech: false });
    await live.flush();
    assert.deepEqual(calls.get('CAmiddecode').history, [], 'the late transcript never lands');
    assert.equal(turns.length, 0, 'no late reprompt is logged for the aborted Turn');
    assert.equal(texts.length, 0, 'nothing is spoken for the aborted Turn');

    // The interrupting speech continues into a complete next utterance.
    await feed(live, SPEECH_FRAME, 40);
    await feed(live, SILENCE_FRAME, 40);
    await live.flush();
    await waitFor(() => calls.get('CAmiddecode').history.length === 1, 'the interrupting Turn to complete');
    assert.deepEqual(
      calls.get('CAmiddecode').history.map((entry) => entry.text),
      ['second turn words'],
      'interrupting speech becomes the next Turn intact',
    );
    assert.ok(stopMs < 10_000, `the Turn recovers via barge-in, not the deadline (${stopMs}ms)`);
    live.close('test');
    await live.flush();
  });

  it('brief noise during transcription does not abort the decode', async () => {
    const calls = new CallStore();
    const { tts } = stubTts();
    let count = 0;
    const signals: AbortSignal[] = [];
    let release!: (tx: Transcription) => void;
    const gate = new Promise<Transcription>((resolve) => {
      release = resolve;
    });
    const live = new LiveCallSession({
      identity: { callSid: 'CAmidnoise', streamSid: 'MZmidnoise' },
      sendAudio: () => {},
      vad: byteVad,
      policy: POLICY,
      transcriber: {
        transcribe: (_audio, _contentType, signal) => {
          count += 1;
          if (signal) signals.push(signal);
          if (count === 1) return gate;
          return Promise.resolve({ text: 'second turn words', noSpeech: false });
        },
      },
      tts,
      guide: GUIDE,
      calls,
      bargeInMinSpeechMs: 200,
      transcribeDeadlineMs: 10_000,
    });

    await feed(live, SPEECH_FRAME, 50);
    await feed(live, SILENCE_FRAME, 30);
    await waitFor(() => count === 1, 'the hung decode to start');
    // 100 ms of noise: below the 200 ms energy pre-trigger.
    await feed(live, SPEECH_FRAME, 5);
    await feed(live, SILENCE_FRAME, 10);
    assert.equal(signals[0]!.aborted, false, 'brief noise never aborts the decode');
    release({ text: 'first turn words', noSpeech: false });
    await live.flush();
    await waitFor(() => calls.get('CAmidnoise').history.length === 1, 'the first Turn to complete');
    assert.equal(calls.get('CAmidnoise').history[0]!.text, 'first turn words');
    live.close('test');
    await live.flush();
  });

  it('speech during a healthy (slow) transcription still becomes the next Turn; stop latency is bounded', async () => {
    const calls = new CallStore();
    const { tts } = stubTts();
    const turns: TurnEvent[] = [];
    let count = 0;
    const signals: AbortSignal[] = [];
    const live = new LiveCallSession({
      identity: { callSid: 'CAmidhealthy', streamSid: 'MZmidhealthy' },
      sendAudio: () => {},
      vad: byteVad,
      policy: POLICY,
      transcriber: {
        transcribe: (_audio, _contentType, signal) => {
          count += 1;
          if (signal) signals.push(signal);
          if (count === 1) {
            // Healthy but slow: resolves after 600 ms unless aborted first.
            return new Promise<Transcription>((resolve, reject) => {
              if (signal?.aborted) {
                reject(new Error('aborted'));
                return;
              }
              const timer = setTimeout(() => resolve({ text: 'first turn words', noSpeech: false }), 600);
              timer.unref?.();
              signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new Error('aborted'));
              }, { once: true });
            });
          }
          return Promise.resolve({ text: 'repair, I meant tomorrow', noSpeech: false });
        },
      },
      tts,
      guide: GUIDE,
      calls,
      bargeInMinSpeechMs: 200,
      transcribeDeadlineMs: 10_000,
      logTurn: (e) => turns.push(e),
    });

    await feed(live, SPEECH_FRAME, 50);
    await feed(live, SILENCE_FRAME, 30);
    await waitFor(() => count === 1, 'the slow decode to start');

    // Interrupt after ~100 ms of decode, well before the 600 ms resolve.
    await feed(live, SILENCE_FRAME, 5);
    const framesBefore = 5;
    let fed = 0;
    const stopStart = Date.now();
    for (let i = 0; i < 20 && !signals[0]!.aborted; i++) {
      await live.receiveAudio(SPEECH_FRAME);
      fed += 1;
    }
    const stopFrames = framesBefore + fed;
    const stopMs = Date.now() - stopStart;
    assert.equal(signals[0]!.aborted, true, 'the healthy decode aborts on interrupting speech');
    // Fast energy path: 200 ms pre-trigger plus frame slack, far below any lag window.
    assert.ok(fed <= 15, `stop latency is bounded (${fed} speech frames, ~${fed * 20}ms)`);
    // Finish the interrupting utterance so it endpoints.
    await feed(live, SPEECH_FRAME, 40);
    await feed(live, SILENCE_FRAME, 40);
    await live.flush();
    await waitFor(() => calls.get('CAmidhealthy').history.length === 1, 'the interrupting Turn to complete');
    assert.deepEqual(
      calls.get('CAmidhealthy').history.map((entry) => entry.text),
      ['repair, I meant tomorrow'],
      'interrupting speech becomes the next Turn intact',
    );
    assert.equal(
      calls.get('CAmidhealthy').history.some((h) => h.text === 'first turn words'),
      false,
      'the aborted healthy decode never lands late',
    );
    assert.equal(turns.length, 0, 'no double reply for the aborted Turn');
    // eslint-disable-next-line no-console
    console.log(`[ticket-16] stop-latency: ${fed} frames (~${fed * 20}ms audio, ${stopMs}ms wall, ${stopFrames} frames incl. lead silence)`);
    live.close('test');
    await live.flush();
  });

  it('silence during transcription never fires a barge-in', async () => {
    const calls = new CallStore();
    const { tts } = stubTts();
    let count = 0;
    const signals: AbortSignal[] = [];
    let release!: (tx: Transcription) => void;
    const gate = new Promise<Transcription>((resolve) => {
      release = resolve;
    });
    const live = new LiveCallSession({
      identity: { callSid: 'CAmidsilence', streamSid: 'MZmidnoise2' },
      sendAudio: () => {},
      vad: byteVad,
      policy: POLICY,
      transcriber: {
        transcribe: (_audio, _contentType, signal) => {
          count += 1;
          if (signal) signals.push(signal);
          return gate;
        },
      },
      tts,
      guide: GUIDE,
      calls,
      bargeInMinSpeechMs: 200,
      transcribeDeadlineMs: 10_000,
    });
    void FRAME_BYTES;
    await feed(live, SPEECH_FRAME, 50);
    await feed(live, SILENCE_FRAME, 30);
    await waitFor(() => count === 1, 'the hung decode to start');
    await feed(live, SILENCE_FRAME, 50);
    assert.equal(signals[0]!.aborted, false, 'silence never aborts the decode');
    assert.equal(live.currentPhase, 'FINALIZING', 'the Turn stays in flight through silence');
    release({ text: 'first turn words', noSpeech: false });
    await live.flush();
    live.close('test');
    await live.flush();
  });
});
