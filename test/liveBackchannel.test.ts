import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CallStore } from '../src/calls.ts';
import { LiveCallSession } from '../src/live.ts';
import type { Vad } from '../src/endpoint.ts';
import type { Assistant, FailureEvent, Transcription, TurnEvent } from '../src/app.ts';
import type { PartialTranscript, RealtimeEndpointing, RealtimeStt, VadEvent } from '../src/realtimeStt.ts';
import type { PlaybackResult } from '../src/transport.ts';
import type { TraceEvent } from '../src/trace.ts';
import type { Tts } from '../src/tts.ts';

const FRAME_BYTES = 160;
/** Audible caller audio: 0xFF is mu-law silence and can never be Caller speech. */
const SPEECH_FRAME = Buffer.alloc(FRAME_BYTES, 0x11);
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

/**
 * Scripted realtime channel: emits partials from the test (the production
 * carrier of Backchannel semantics) and optional provider VAD boundaries.
 */
class FakePartialStt implements RealtimeStt {
  readonly endpointing: RealtimeEndpointing;
  finalizeCalls = 0;
  private partialHandler: ((partial: PartialTranscript) => void) | null = null;
  private vadHandler: ((event: VadEvent) => void) | null = null;
  private readonly finals: Transcription[];

  constructor(opts: { endpointing: RealtimeEndpointing; finals?: Transcription[] }) {
    this.endpointing = opts.endpointing;
    this.finals = opts.finals ?? [];
  }

  pushAudio(): void {}

  speechStart(): void {}

  finalize(): Promise<Transcription> {
    this.finalizeCalls += 1;
    const tx = this.finals.shift();
    return tx ? Promise.resolve(tx) : Promise.reject(new Error('sarvam-realtime-not-streaming'));
  }

  onPartial(handler: (partial: PartialTranscript) => void): void {
    this.partialHandler = handler;
  }

  partial(text: string): void {
    this.partialHandler?.({ text });
  }

  onVadEvent(handler: (event: VadEvent) => void): void {
    this.vadHandler = handler;
  }

  vad(event: VadEvent): void {
    this.vadHandler?.(event);
  }

  close(): void {}
}

describe('live Backchannel absorption', () => {
  it('absorbs a scripted Backchannel: no stop, no Turn, no history, traced', async () => {
    const calls = new CallStore();
    const { tts, texts } = stubTts();
    const traces: TraceEvent[] = [];
    let cleared = 0;
    const stt = new FakePartialStt({ endpointing: 'vad' });
    const live = new LiveCallSession({
      identity: { callSid: 'CAbc1', streamSid: 'MZbc1' },
      sendAudio: () => {},
      vad: scriptVad(speech(200)),
      policy: POLICY,
      transcriber: queueTranscriber(['mm-hmm']),
      realtime: stt,
      tts,
      guide: GUIDE,
      calls,
      trace: (event) => traces.push(event),
      // Hold the greeting in SPEAKING while the Backchannel arrives.
      finishPlayback: () => new Promise<PlaybackResult>(() => {}),
      clearPlayback: () => {
        cleared += 1;
      },
    });
    void live.open().catch(() => {});
    await waitFor(() => live.currentPhase === 'SPEAKING', 'the greeting to start');
    stt.vad('speech_start');
    for (let i = 0; i < 30; i++) {
      stt.partial('mm-hmm');
      await live.receiveAudio(SPEECH_FRAME);
    }
    stt.vad('speech_end');
    await live.flush();

    assert.equal(cleared, 0, 'a Backchannel never stops the Receptionist');
    assert.equal(live.currentPhase, 'SPEAKING', 'the Receptionist keeps speaking with no gap');
    assert.equal(calls.get('CAbc1').turn, 0, 'a Backchannel is never a Turn');
    assert.equal(calls.get('CAbc1').history.length, 0, 'a Backchannel never enters history');
    assert.equal(texts.length, 1, 'no acknowledgement reply is spoken');
    const absorptions = traces.filter((event) => event.component === 'call' && event.event === 'backchannel');
    assert.equal(absorptions.length, 1, 'the absorption is traced exactly once');
    assert.equal(absorptions[0]!.text, 'mm-hmm');
    assert.ok(Number(absorptions[0]!.durationMs) >= 200, 'the trace carries the candidate duration');
    live.close('test');
  });

  it('distinguishes a short content-bearing interruption and stops on it', async () => {
    const calls = new CallStore();
    const { tts } = stubTts();
    const turns: TurnEvent[] = [];
    const traces: TraceEvent[] = [];
    let cleared = 0;
    let resolveFinish: ((result: PlaybackResult) => void) | null = null;
    const stt = new FakePartialStt({
      endpointing: 'vad',
      finals: [{ text: 'wait, I meant tomorrow', noSpeech: false }],
    });
    const live = new LiveCallSession({
      identity: { callSid: 'CAbc2', streamSid: 'MZbc2' },
      sendAudio: () => {},
      vad: scriptVad(speech(200)),
      policy: POLICY,
      transcriber: queueTranscriber(['rest transcript']),
      realtime: stt,
      tts,
      guide: GUIDE,
      assistant: {
        reply: async () => ({ text: '', endCall: false }),
        replyStream: async function* () {
          yield 'Sure, let me check that. ';
        },
      },
      calls,
      trace: (event) => traces.push(event),
      logTurn: (event) => turns.push(event),
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
    void live.open().catch(() => {});
    await waitFor(() => live.currentPhase === 'SPEAKING', 'the greeting to start');
    for (let i = 0; i < 30; i++) {
      stt.partial('wait, I meant tomorrow');
      await live.receiveAudio(SPEECH_FRAME);
    }
    await waitFor(() => cleared === 1, 'the content interruption to stop the greeting');
    assert.equal(
      traces.filter((event) => event.component === 'call' && event.event === 'backchannel').length,
      0,
      'content-bearing speech is never absorbed as a Backchannel',
    );
    // The interruption's provider boundary closes its Turn with its final.
    stt.vad('speech_end');
    await live.flush();

    assert.equal(calls.get('CAbc2').turn, 1, 'the interruption becomes a Turn');
    assert.equal(calls.get('CAbc2').history[0]!.text, 'wait, I meant tomorrow');
    assert.ok(turns.some((event) => event.excerpt === 'wait, I meant tomorrow'));
    live.close('test');
  });

  it('takes the floor when partial semantics never arrive, after the confirm hold', async () => {
    const calls = new CallStore();
    const { tts } = stubTts();
    let cleared = 0;
    const stt = new FakePartialStt({ endpointing: 'manual' });
    const live = new LiveCallSession({
      identity: { callSid: 'CAbc4', streamSid: 'MZbc4' },
      sendAudio: () => {},
      vad: scriptVad(speech(200)),
      policy: POLICY,
      transcriber: queueTranscriber(['no wait']),
      realtime: stt,
      partialSemantics: true,
      tts,
      guide: GUIDE,
      calls,
      finishPlayback: () =>
        cleared === 0
          ? new Promise<PlaybackResult>(() => {})
          : Promise.resolve({ outcome: 'played', mark: '' }),
      clearPlayback: () => {
        cleared += 1;
      },
    });
    void live.open().catch(() => {});
    await waitFor(() => live.currentPhase === 'SPEAKING', 'the greeting to start');
    // No partial arrives, so the energy candidate waits out the confirm hold
    // (200 ms pre-trigger + 300 ms) instead of firing at the pre-trigger.
    for (let i = 0; i < 24; i++) await live.receiveAudio(SPEECH_FRAME);
    assert.equal(cleared, 0, 'unknown speech does not fire before the confirm hold ends');
    await live.receiveAudio(SPEECH_FRAME);
    assert.equal(cleared, 1, 'unknown speech still takes the floor');
    live.close('test');
  });

  it('lets a fresh content-bearing burst take the floor after an absorbed Backchannel', async () => {
    const calls = new CallStore();
    const { tts } = stubTts();
    const traces: TraceEvent[] = [];
    let cleared = 0;
    let speechOn = true;
    const vad: Vad = { score: async () => (speechOn ? 0.9 : 0.05), reset: () => {} };
    const stt = new FakePartialStt({ endpointing: 'manual' });
    const live = new LiveCallSession({
      identity: { callSid: 'CAbc5', streamSid: 'MZbc5' },
      sendAudio: () => {},
      vad,
      policy: POLICY,
      transcriber: queueTranscriber(['no wait']),
      realtime: stt,
      partialSemantics: true,
      tts,
      guide: GUIDE,
      calls,
      trace: (event) => traces.push(event),
      finishPlayback: () =>
        cleared === 0
          ? new Promise<PlaybackResult>(() => {})
          : Promise.resolve({ outcome: 'played', mark: '' }),
      clearPlayback: () => {
        cleared += 1;
      },
    });
    void live.open().catch(() => {});
    await waitFor(() => live.currentPhase === 'SPEAKING', 'the greeting to start');
    // The Backchannel is absorbed.
    for (let i = 0; i < 10; i++) {
      stt.partial('mm-hmm');
      await live.receiveAudio(SPEECH_FRAME);
    }
    assert.equal(cleared, 0, 'the Backchannel does not stop the greeting');
    // The gap ends the absorbed utterance, and the next burst carries no
    // partial at all: it must still be allowed to take the floor.
    speechOn = false;
    for (let i = 0; i < 15; i++) await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
    speechOn = true;
    for (let i = 0; i < 30 && cleared === 0; i++) await live.receiveAudio(SPEECH_FRAME);

    assert.equal(cleared, 1, 'content-bearing speech after the Backchannel still barge in');
    const absorptions = traces.filter((event) => event.component === 'call' && event.event === 'backchannel');
    assert.equal(absorptions.length, 1, 'the absorption is traced once');
    live.close('test');
  });

  it('does not absorb affirmatives during a readback: they interrupt it instead', async () => {
    const calls = new CallStore();
    const { tts, texts } = stubTts();
    const failures: FailureEvent[] = [];
    const proposed: unknown[] = [];
    let cleared = 0;
    let resolveFinish: ((result: PlaybackResult) => void) | null = null;
    const stt = new FakePartialStt({ endpointing: 'manual' });
    const live = new LiveCallSession({
      identity: { callSid: 'CAbc3', streamSid: 'MZbc3' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50), ...speech(30), ...silence(80)]),
      policy: POLICY,
      transcriber: queueTranscriber(['book Wednesday at 9:30, my name is Asha, 9840950950', 'yes']),
      realtime: stt,
      partialSemantics: true,
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
      logFailure: (event) => failures.push(event),
    });
    const firstFeed = (async () => {
      for (let i = 0; i < 100; i++) await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
      await live.flush();
    })();
    await waitFor(() => live.currentPhase === 'SPEAKING', 'the readback to play');
    assert.ok(texts.some((t) => /Shall I book it\?/.test(t)), 'the readback is spoken');
    // "okay" mid-readback is an answer to the readback question, not a Backchannel.
    for (let i = 0; i < 30; i++) {
      stt.partial('okay');
      await live.receiveAudio(SPEECH_FRAME);
    }
    await waitFor(() => cleared === 1, 'the readback interruption');
    assert.equal(live.state.readback, undefined, 'the interrupted readback is cleared');
    assert.equal(proposed.length, 0, 'a readback cannot be confirmed by speech it never heard');
    for (let i = 0; i < 60; i++) await live.receiveAudio(SPEECH_FRAME);
    await live.flush();
    await firstFeed;
    assert.equal(failures.length, 0);
    live.close('test');
  });
});
