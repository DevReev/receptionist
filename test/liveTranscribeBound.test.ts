import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REPROMPT_LINE, type Transcription, type TurnEvent } from '../src/app.ts';
import { CallStore } from '../src/calls.ts';
import type { BargeInEvent, Vad } from '../src/endpoint.ts';
import { LiveCallSession } from '../src/live.ts';
import type { RealtimeStt } from '../src/realtimeStt.ts';
import type { TraceEvent } from '../src/trace.ts';
import type { Tts } from '../src/tts.ts';

const FRAME_BYTES = 160;
const POLICY = { silenceMs: 400, minSpeechMs: 300, maxUtteranceMs: 30000, threshold: 0.5, latchDipMs: 200 };
const GUIDE = { raw: '# Clinic Guide — Maple Clinic\n', name: 'Maple Clinic' };

const unhandledRejections: unknown[] = [];
process.on('unhandledRejection', (reason) => {
  unhandledRejections.push(reason);
});

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
const oneUtterance = (): ('speech' | 'silence')[] => [...speech(50), ...silence(50)];
const AVAILABILITY_SLOT =
  'AVAILABILITY (fetched live — only these slots exist)\n- 2026-09-30 09:30 Appointment with Bob Gowda at Bobby Clinic';

/** VAD under direct test control: idle-dropped frames never skew a script. */
function manualVad(): { vad: Vad; speak: () => void; hush: () => void } {
  let talking = true;
  return {
    vad: {
      score: async () => (talking ? 0.9 : 0.05),
      reset: () => {},
    },
    speak: () => {
      talking = true;
    },
    hush: () => {
      talking = false;
    },
  };
}

function stubTts(): { tts: Tts; texts: string[] } {
  const texts: string[] = [];
  const tts: Tts = {
    synthesize: async (text: string) => {
      texts.push(text);
      return { audio: Buffer.from([0xff]) };
    },
  };
  return { tts, texts };
}

async function waitFor(cond: () => boolean, what: string, budgetMs = 2000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Feed frames without flushing: the Turn may legitimately stay in flight. */
async function feedFrames(live: LiveCallSession, frames: number): Promise<void> {
  for (let i = 0; i < frames; i++) await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
}

/** A REST decode that hangs until released, recording every signal it saw. */
function hungTranscriber(): {
  transcribe: (audio: Buffer, contentType: string, signal?: AbortSignal) => Promise<Transcription>;
  signals: AbortSignal[];
  started: () => number;
  release: (tx: Transcription) => void;
} {
  const signals: AbortSignal[] = [];
  let count = 0;
  let release!: (tx: Transcription) => void;
  const gate = new Promise<Transcription>((resolve) => {
    release = resolve;
  });
  return {
    transcribe: (_audio, _contentType, signal) => {
      count += 1;
      if (signal) signals.push(signal);
      return gate;
    },
    signals,
    started: () => count,
    release,
  };
}

/** A REST decode that hangs until its signal aborts, then rejects. */
function abortableHungTranscriber(signals: AbortSignal[]): {
  transcribe: (audio: Buffer, contentType: string, signal?: AbortSignal) => Promise<Transcription>;
} {
  return {
    transcribe: (_audio, _contentType, signal) =>
      new Promise<Transcription>((_resolve, reject) => {
        if (signal) {
          signals.push(signal);
          if (signal.aborted) {
            reject(new Error('aborted'));
            return;
          }
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }
      }),
  };
}

class FakeRealtime implements RealtimeStt {
  readonly partials = false;
  private readonly finalizeFn: () => Promise<Transcription>;
  constructor(finalizeFn: () => Promise<Transcription>) {
    this.finalizeFn = finalizeFn;
  }
  pushAudio(): void {}
  speechStart(): void {}
  finalize(): Promise<Transcription> {
    return this.finalizeFn();
  }
  close(): void {}
}

class ScriptRealtime implements RealtimeStt {
  readonly partials = false;
  private readonly script: (() => Promise<Transcription>)[];
  constructor(script: (() => Promise<Transcription>)[]) {
    this.script = script;
  }
  pushAudio(): void {}
  speechStart(): void {}
  finalize(): Promise<Transcription> {
    const next = this.script.shift();
    if (!next) return Promise.reject(new Error('no scripted final'));
    return next();
  }
  close(): void {}
}

describe('bounded transcription (ticket 03)', () => {
  it('resolves a hung REST decode within the deadline with a reprompt and a timeout trace', async () => {
    const calls = new CallStore();
    const { tts, texts } = stubTts();
    const turns: TurnEvent[] = [];
    const traces: TraceEvent[] = [];
    const phases: Record<string, unknown>[] = [];
    const hung = hungTranscriber();
    const live = new LiveCallSession({
      identity: { callSid: 'CAsttdeadline', streamSid: 'MZsttdeadline' },
      sendAudio: () => {},
      vad: scriptVad(oneUtterance()),
      policy: POLICY,
      transcriber: hung,
      tts,
      guide: GUIDE,
      calls,
      transcribeDeadlineMs: 50,
      trace: (e) => traces.push(e),
      logSession: (e) => phases.push(e),
      logTurn: (e) => turns.push(e),
    });
    const started = Date.now();
    await feedFrames(live, 100);
    await waitFor(() => hung.started() === 1, 'the REST decode to start');
    await waitFor(() => turns.length === 1, 'the bounded Turn');
    const elapsed = Date.now() - started;
    await live.flush();

    assert.ok(elapsed < 1500, `the Turn resolves within a bounded wait, not indefinitely (${elapsed}ms)`);
    assert.equal(turns[0]!.miss, true);
    assert.equal(turns[0]!.reply, REPROMPT_LINE);
    assert.ok(texts.some((text) => /say that again/.test(text)), 'the Caller hears the reprompt');
    assert.ok(
      traces.some((e) => e.component === 'stt' && e.event === 'deadline'),
      'the timeout reason is traced',
    );
    assert.ok(
      phases.some((e) => e.phase === 'transcribe' && e.event === 'timeout'),
      'the transcribe phase logs the timeout',
    );
    assert.equal(hung.signals[0]!.aborted, true, 'the hung decode is cancelled');
    assert.deepEqual(
      calls.get('CAsttdeadline').history,
      [],
      'no transcript reaches history',
    );
    live.close('test');
  });

  it('barge-in aborts the in-flight decode and no late transcript reaches the session', async () => {
    const calls = new CallStore();
    const { tts, texts } = stubTts();
    const turns: TurnEvent[] = [];
    const mic = manualVad();
    let count = 0;
    const signals: AbortSignal[] = [];
    let releaseLate!: (tx: Transcription) => void;
    const lateGate = new Promise<Transcription>((resolve) => {
      releaseLate = resolve;
    });
    const live = new LiveCallSession({
      identity: { callSid: 'CAsttbarge', streamSid: 'MZsttbarge' },
      sendAudio: () => {},
      vad: mic.vad,
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
      transcribeDeadlineMs: 10_000,
      logTurn: (e) => turns.push(e),
    });
    mic.speak();
    await feedFrames(live, 50);
    mic.hush();
    await feedFrames(live, 50);
    await waitFor(() => count === 1, 'the first decode to start');
    // The detector fires while the decode is in flight; the retained candidate
    // becomes the next utterance.
    (live as unknown as { handleBargeIn: (event: BargeInEvent) => void }).handleBargeIn({
      audio: new Int16Array(1600),
      durationMs: 250,
    });
    assert.equal(signals[0]!.aborted, true, 'the stub observes the abort');
    // The provider ignores the signal and resolves late anyway.
    releaseLate({ text: 'late words', noSpeech: false });
    await live.flush();
    assert.deepEqual(calls.get('CAsttbarge').history, [], 'the late transcript never lands');
    assert.equal(turns.length, 0, 'no late reprompt is logged');
    assert.equal(texts.length, 0, 'nothing is spoken for the aborted Turn');
    // The promoted Turn still completes normally afterwards: speech first, so
    // the retained candidate never endpoints on its own.
    mic.speak();
    await feedFrames(live, 60);
    mic.hush();
    await feedFrames(live, 50);
    await live.flush();
    assert.deepEqual(
      calls.get('CAsttbarge').history.map((entry) => entry.text),
      ['second turn words'],
    );
    assert.equal(turns.length, 0, 'the follow-up Turn stays silent without an assistant');
    live.close('test');
  });

  it('a realtime final landing after the REST deadline still wins with no double reply', async () => {
    const calls = new CallStore();
    const { tts, texts } = stubTts();
    const turns: TurnEvent[] = [];
    const hung = hungTranscriber();
    const live = new LiveCallSession({
      identity: { callSid: 'CAsttfinal', streamSid: 'MZsttfinal' },
      sendAudio: () => {},
      vad: scriptVad(oneUtterance()),
      policy: POLICY,
      transcriber: hung,
      realtime: new FakeRealtime(
        () =>
          new Promise<Transcription>((resolve) =>
            setTimeout(() => resolve({ text: 'late realtime words', noSpeech: false }), 150),
          ),
      ),
      tts,
      guide: GUIDE,
      assistant: {
        reply: async () => ({ text: '', endCall: false }),
        replyStream: async function* () {
          yield 'We are open today. ';
        },
      },
      calls,
      transcribeDeadlineMs: 50,
      logTurn: (e) => turns.push(e),
    });
    await feedFrames(live, 100);
    await live.flush();
    assert.deepEqual(
      calls.get('CAsttfinal').history.map((entry) => entry.text),
      ['late realtime words', 'We are open today.'],
      'the late final answers the Turn exactly once',
    );
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.miss, false);
    assert.equal(texts.filter((text) => /say that again/.test(text)).length, 0, 'no reprompt around the late final');
    assert.equal(texts.filter((text) => /open today/.test(text)).length, 1, 'exactly one reply');
    live.close('test');
    await live.flush();
  });

  it('close aborts the hedge, second opinion, and warm-up with no unhandled rejection', async () => {
    // Warm-up decode aborted on close.
    {
      const warmSignals: AbortSignal[] = [];
      const { tts } = stubTts();
      const live = new LiveCallSession({
        identity: { callSid: 'CAsttwarm', streamSid: 'MZsttwarm' },
        sendAudio: () => {},
        vad: scriptVad(silence(5)),
        policy: POLICY,
        transcriber: abortableHungTranscriber(warmSignals),
        tts,
        guide: GUIDE,
        calls: new CallStore(),
        warmTranscriber: true,
      });
      void live.open().catch(() => {});
      await waitFor(() => warmSignals.length === 1, 'the warm-up decode to start');
      live.close('test');
      assert.equal(warmSignals[0]!.aborted, true, 'close aborts the warm-up decode');
      await live.flush();
    }

    // Primary REST decode aborted on close.
    {
      const restSignals: AbortSignal[] = [];
      const { tts } = stubTts();
      const turns: TurnEvent[] = [];
      const calls = new CallStore();
      const live = new LiveCallSession({
        identity: { callSid: 'CAsttclose', streamSid: 'MZsttclose' },
        sendAudio: () => {},
        vad: scriptVad(oneUtterance()),
        policy: POLICY,
        transcriber: abortableHungTranscriber(restSignals),
        tts,
        guide: GUIDE,
        calls,
        transcribeDeadlineMs: 10_000,
        logTurn: (e) => turns.push(e),
      });
      await feedFrames(live, 100);
      await waitFor(() => restSignals.length === 1, 'the REST decode to start');
      live.close('socket-closed');
      assert.equal(restSignals[0]!.aborted, true, 'close aborts the in-flight decode');
      await live.flush();
      assert.equal(turns.length, 1, 'close drains the partial Turn');
      assert.equal(calls.get('CAsttclose').history.length, 0, 'no transcript lands after close');
    }

    // Hedge + second-opinion decodes aborted on close.
    {
      const hedgeSignals: AbortSignal[] = [];
      const secondSignals: AbortSignal[] = [];
      const { tts } = stubTts();
      const calls = new CallStore();
      const live = new LiveCallSession({
        identity: { callSid: 'CAsttsecond', streamSid: 'MZsttsecond' },
        sendAudio: () => {},
        vad: scriptVad([...oneUtterance(), ...oneUtterance()]),
        policy: POLICY,
        transcriber: {
          transcribe: (_audio, _contentType, signal) => {
            if (signal) hedgeSignals.push(signal);
            return Promise.resolve({ text: 'hedge words', noSpeech: false });
          },
        },
        realtime: new ScriptRealtime([
          async () => ({ text: 'book Wednesday', noSpeech: false }),
          async () => ({ text: 'my name is Rahul', noSpeech: false }),
        ]),
        secondOpinion: abortableHungTranscriber(secondSignals),
        tts,
        guide: GUIDE,
        availability: AVAILABILITY_SLOT,
        calls,
        transcribeDeadlineMs: 10_000,
      });
      await feedFrames(live, 100);
      await live.flush();
      assert.equal(live.state.phase, 'collecting-patient');
      await feedFrames(live, 100);
      await waitFor(() => secondSignals.length === 1, 'the second-opinion decode to start');
      live.close('socket-closed');
      assert.equal(secondSignals[0]!.aborted, true, 'close aborts the second-opinion decode');
      await live.flush();
      assert.equal(live.isClosed, true);
    }

    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(unhandledRejections, [], 'no decode rejects unhandled after close');
  });
});
