import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeMulaw } from '../src/audio.ts';
import { CallStore } from '../src/calls.ts';
import { LiveCallSession } from '../src/live.ts';
import type { Vad } from '../src/endpoint.ts';
import type { Assistant, AssistantContext, FailureEvent, Transcription, TurnEvent } from '../src/app.ts';
import { HOLD_ASSISTANT_LINE } from '../src/app.ts';
import type { PlaybackResult } from '../src/transport.ts';
import type { Tts } from '../src/tts.ts';
import { echoFrame, voice } from './voiceFixtures.ts';
import { FRAME_BYTES, SPEECH_FRAME } from './fakeStream.ts';
const POLICY = { silenceMs: 700, minSpeechMs: 300, maxUtteranceMs: 30000, threshold: 0.5, latchDipMs: 200 };
const GUIDE = { raw: '# Clinic Guide — Maple Clinic\n', name: 'Maple Clinic' };
const AVAILABILITY =
  'AVAILABILITY (fetched live — only these slots exist)\n- 2026-09-30 09:30 Appointment with Bob Gowda at Bobby Clinic';

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

async function feed(live: LiveCallSession, frames: number): Promise<void> {
  for (let i = 0; i < frames; i++) await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
  await live.flush();
}

describe('live barge-in', () => {
  it('clears audible speech, drops unheard wording, and keeps the interruption as one new Turn', async () => {
    const calls = new CallStore();
    const { tts } = stubTts();
    const turns: TurnEvent[] = [];
    const failures: FailureEvent[] = [];
    let cleared = 0;
    let resolveFinish: ((result: PlaybackResult) => void) | null = null;
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
      logTurn: (e) => turns.push(e),
      logFailure: (e) => failures.push(e),
    });

    const firstFeed = (async () => {
      for (let i = 0; i < 100; i++) await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
      await live.flush();
    })();
    await waitFor(() => live.currentPhase === 'SPEAKING', 'the reply to start');
    // Sustained Caller speech while the Receptionist speaks.
    for (let i = 0; i < 20; i++) await live.receiveAudio(SPEECH_FRAME);
    await waitFor(() => cleared === 1, 'the barge-in candidate to fire');
    assert.equal(live.currentPhase, 'LISTENING');
    // The retained candidate continues into the next utterance.
    for (let i = 0; i < 50; i++) await live.receiveAudio(SPEECH_FRAME);
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
    const { tts, texts } = stubTts();
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
      bargeInMinSpeechMs: 200,
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
    for (let i = 0; i < 5; i++) await live.receiveAudio(SPEECH_FRAME);
    for (let i = 0; i < 20; i++) await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
    assert.equal(cleared, 0, 'brief noise never interrupts');
    assert.equal(live.currentPhase, 'SPEAKING');
    (resolveFinish as ((result: PlaybackResult) => void) | null)?.({ outcome: 'played', mark: '' });
    await firstFeed;
    assert.ok(texts.some((t) => t.includes('longer answer')));
    live.close('test');
  });

  it('stops the greeting and keeps the interruption as a Turn', async () => {
    const calls = new CallStore();
    const { tts } = stubTts();
    const turns: TurnEvent[] = [];
    let cleared = 0;
    let resolveFinish: ((result: PlaybackResult) => void) | null = null;
    const live = new LiveCallSession({
      identity: { callSid: 'CAgreet', streamSid: 'MZgreet' },
      sendAudio: () => {},
      vad: scriptVad([...speech(30), ...silence(80)]),
      policy: POLICY,
      transcriber: queueTranscriber(['excuse me, are you open today']),
      tts,
      guide: GUIDE,
      assistant: {
        reply: async () => ({ text: '', endCall: false }),
        replyStream: async function* () {
          yield 'We are open today. ';
        },
      },
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
      logTurn: (e) => turns.push(e),
    });
    void live.open().catch(() => {});
    await waitFor(() => live.currentPhase === 'SPEAKING', 'the greeting to start');
    for (let i = 0; i < 15; i++) await live.receiveAudio(SPEECH_FRAME);
    await waitFor(() => cleared === 1, 'the greeting barge-in');
    for (let i = 0; i < 80; i++) await live.receiveAudio(SPEECH_FRAME);
    await live.flush();

    assert.equal(cleared, 1, 'the greeting is stopped');
    assert.equal(calls.get('CAgreet').turn, 1);
    assert.equal(calls.get('CAgreet').history[0]!.text, 'excuse me, are you open today');
    assert.ok(turns.some((t) => /open today/.test(t.reply)));
    live.close('test');
  });

  it('stops a hold line, aborts the reply it was waiting on, and starts the new Turn', async () => {
    const calls = new CallStore();
    const { tts, texts } = stubTts();
    let cleared = 0;
    let holdGated = true;
    let releaseToken: (() => void) | null = null;
    const tokenGate = new Promise<void>((resolve) => {
      releaseToken = resolve;
    });
    let resolveFinish: ((result: PlaybackResult) => void) | null = null;
    const live = new LiveCallSession({
      identity: { callSid: 'CAhold', streamSid: 'MZhold' },
      sendAudio: () => {},
      // No partial channel: the local detector takes the 500 ms no-partials
      // floor (25 frames), so the scripted interruption starts where the
      // session's own boundary lands.
      vad: scriptVad([...speech(50), ...silence(25), ...speech(60), ...silence(100)]),
      policy: POLICY,
      transcriber: queueTranscriber(['what are your hours', 'never mind']),
      tts,
      guide: GUIDE,
      assistant: {
        reply: async () => ({ text: '', endCall: false }),
        replyStream: async function* (ctx: AssistantContext) {
          if (ctx.transcript.includes('hours')) {
            await tokenGate;
            yield 'We are open Monday to Friday. ';
          } else {
            yield 'Alright. ';
          }
        },
      },
      calls,
      holdAfterMs: 20,
      bargeInMinSpeechMs: 200,
      finishPlayback: () =>
        holdGated && texts.includes(HOLD_ASSISTANT_LINE)
          ? new Promise<PlaybackResult>((resolve) => {
              resolveFinish = resolve;
            })
          : Promise.resolve({ outcome: 'played', mark: '' }),
      clearPlayback: (reason) => {
        cleared += 1;
        holdGated = false;
        resolveFinish?.({ outcome: 'cleared', mark: '', reason });
      },
    });
    const firstFeed = (async () => {
      for (let i = 0; i < 100; i++) await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
      await live.flush();
    })();
    await waitFor(() => texts.includes(HOLD_ASSISTANT_LINE), 'the hold line to play');
    for (let i = 0; i < 20; i++) await live.receiveAudio(SPEECH_FRAME);
    await waitFor(() => cleared === 1, 'the hold-line barge-in');
    (releaseToken as (() => void) | null)?.();
    for (let i = 0; i < 80; i++) await live.receiveAudio(SPEECH_FRAME);
    await live.flush();
    await firstFeed;
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(cleared, 1);
    assert.equal(calls.get('CAhold').turn, 2, 'the interruption starts the next Turn');
    assert.equal(calls.get('CAhold').history[0]!.text, 'what are your hours');
    assert.ok(texts.includes('Alright.'), 'the new Turn is answered');
    assert.equal(
      texts.some((t) => t.includes('Monday to Friday')),
      false,
      'the aborted generation is never spoken after the interruption',
    );
    assert.equal(calls.get('CAhold').history.some((h) => h.text.includes('Monday to Friday')), false);
    assert.equal(live.isClosed, false);
    live.close('test');
  });

  it('never stops on the Receptionist\'s own returning Echo', async () => {
    const calls = new CallStore();
    const { tts } = stubTts();
    let cleared = 0;
    const vad: Vad = { score: async () => 0.9, reset: () => {} };
    const live = new LiveCallSession({
      identity: { callSid: 'CAecho', streamSid: 'MZecho' },
      sendAudio: () => {},
      vad,
      policy: POLICY,
      transcriber: { transcribe: async () => ({ text: '', noSpeech: true }) },
      tts,
      guide: GUIDE,
      calls,
      // Hold the greeting in SPEAKING while the Echo returns.
      finishPlayback: () => new Promise(() => {}),
    });
    void live.open().catch(() => {});
    await waitFor(() => live.currentPhase === 'SPEAKING', 'the greeting to start');
    const ref = voice(FRAME_BYTES * 100, 5);
    for (let t = 0; t < 100; t++) {
      live.retainReference(encodeMulaw(ref.subarray(t * FRAME_BYTES, (t + 1) * FRAME_BYTES)));
      await live.receiveAudio(encodeMulaw(echoFrame(ref, t, 240, 0.125)));
    }
    assert.equal(cleared, 0, 'self-Echo never stops the Receptionist');
    assert.equal(live.currentPhase, 'SPEAKING');
    assert.equal(calls.get('CAecho').turn, 0, 'no self-Echo-triggered Turn');
    live.close('test');
  });

  it('an interrupted readback can never authorize a Booking', async () => {
    const calls = new CallStore();
    const { tts, texts } = stubTts();
    const proposed: unknown[] = [];
    let cleared = 0;
    let resolveFinish: ((result: PlaybackResult) => void) | null = null;
    const live = new LiveCallSession({
      identity: { callSid: 'CAreadback', streamSid: 'MZreadback' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50), ...speech(30), ...silence(80)]),
      policy: POLICY,
      transcriber: queueTranscriber(['book Wednesday at 9:30, my name is Asha, 9840950950', 'yes']),
      tts,
      guide: GUIDE,
      availability: AVAILABILITY,
      calls,
      bargeInMinSpeechMs: 200,
      onProposeBooking: async () => {
        proposed.push(1);
        return { ok: true };
      },
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
    });
    const firstFeed = (async () => {
      for (let i = 0; i < 100; i++) await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
      await live.flush();
    })();
    await waitFor(() => live.currentPhase === 'SPEAKING', 'the readback to play');
    assert.ok(texts.some((t) => /Shall I book it\?/.test(t)), 'the readback is spoken');
    // Interrupt the readback and let the interruption become a Turn.
    for (let i = 0; i < 30; i++) await live.receiveAudio(SPEECH_FRAME);
    await waitFor(() => cleared === 1, 'the readback barge-in');
    assert.equal(live.state.readback, undefined, 'the interrupted readback is cleared');
    for (let i = 0; i < 60; i++) await live.receiveAudio(SPEECH_FRAME);
    await live.flush();
    await firstFeed;
    await waitFor(() => calls.get('CAreadback').turn === 2, 'the interruption Turn');
    await live.flush();

    assert.equal(proposed.length, 0, 'an interrupted readback never authorizes a Booking');
    assert.equal(texts.some((t) => /Booked/.test(t)), false);
    assert.equal(live.isClosed, false);
    live.close('test');
  });

  it('never cancels a Booking write that is already in flight', async () => {
    const calls = new CallStore();
    const { tts, texts } = stubTts();
    const proposed: unknown[] = [];
    let cleared = 0;
    let releaseBooking: (() => void) | null = null;
    const bookingGate = new Promise<void>((resolve) => {
      releaseBooking = resolve;
    });
    const live = new LiveCallSession({
      identity: { callSid: 'CAwrite', streamSid: 'MZwrite' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50), ...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: queueTranscriber(['book Wednesday at 9:30, my name is Asha, 9840950950', 'yes']),
      tts,
      guide: GUIDE,
      availability: AVAILABILITY,
      calls,
      bargeInMinSpeechMs: 200,
      onProposeBooking: async () => {
        proposed.push(1);
        await bookingGate;
        return { ok: true };
      },
      clearPlayback: () => {
        cleared += 1;
      },
    });
    await feed(live, 100);
    assert.ok(texts.some((t) => /Shall I book it\?/.test(t)), 'the readback played');
    const confirm = feed(live, 100);
    await waitFor(() => proposed.length === 1, 'the Booking write to start');
    // The Caller keeps talking while the write is in flight.
    for (let i = 0; i < 50; i++) await live.receiveAudio(SPEECH_FRAME);
    (releaseBooking as (() => void) | null)?.();
    await confirm;
    await waitFor(() => texts.some((t) => /Booked/.test(t)), 'the Booking outcome');
    assert.equal(cleared, 0, 'nothing cancels a write that has begun');
    assert.equal(proposed.length, 1, 'the in-flight write is never cancelled');
    live.close('test');
  });
});
