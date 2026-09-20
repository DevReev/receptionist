import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CallStore } from '../src/calls.ts';
import { LiveCallSession } from '../src/live.ts';
import type { Assistant, Transcriber, Transcription, TurnEvent } from '../src/app.ts';
import type { Vad } from '../src/endpoint.ts';
import type { RealtimeStt } from '../src/realtimeStt.ts';
import type { TraceEvent } from '../src/trace.ts';
import type { Tts } from '../src/tts.ts';

const FRAME_BYTES = 160;
const POLICY = { silenceMs: 400, minSpeechMs: 300, maxUtteranceMs: 30000, threshold: 0.5, latchDipMs: 200 };
const GUIDE = { raw: '# Clinic Guide — Maple Clinic\n', name: 'Maple Clinic' };
const AVAILABILITY_SLOT =
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

function stubTts(chunks = 1): { tts: Tts; synthesized: string[] } {
  const synthesized: string[] = [];
  const tts: Tts = {
    synthesize: async (text: string) => {
      synthesized.push(text);
      return { audio: Buffer.from([0xff]) };
    },
    synthesizeStream: async function* (text: string) {
      synthesized.push(text);
      for (let i = 0; i < chunks; i++) yield Buffer.from([0xff]);
    },
  };
  return { tts, synthesized };
}

async function feed(live: LiveCallSession, frames: number): Promise<void> {
  for (let i = 0; i < frames; i++) {
    await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
  }
  await live.flush();
}

function traced(events: TraceEvent[], component: string, event: string): TraceEvent[] {
  return events.filter((entry) => entry.component === component && entry.event === event);
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Realtime channel whose final is scripted per test. */
class FakeRealtime implements RealtimeStt {
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

/** Realtime channel handing out one scripted final per Turn. */
class ScriptRealtime implements RealtimeStt {
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

function hearingFrames(): ('speech' | 'silence')[] {
  return [...speech(50), ...silence(50)];
}

function hedgedSession(
  callSid: string,
  opts: {
    realtime: RealtimeStt;
    transcriber?: Transcriber;
    traces?: TraceEvent[];
    calls?: CallStore;
  },
): {
  live: LiveCallSession;
  calls: CallStore;
  traces: TraceEvent[];
  transcriptions: string[];
  phases: Record<string, unknown>[];
  texts: string[];
  turns: TurnEvent[];
} {
  const calls = opts.calls ?? new CallStore();
  const traces = opts.traces ?? [];
  const phases: Record<string, unknown>[] = [];
  const transcriptions: string[] = [];
  const turns: TurnEvent[] = [];
  const { tts, synthesized } = stubTts();
  const transcriber: Transcriber =
    opts.transcriber ??
    {
      transcribe: async () => {
        transcriptions.push('rest');
        return { text: 'rest words', noSpeech: false };
      },
    };
  const live = new LiveCallSession({
    identity: { callSid, streamSid: `MZ${callSid}` },
    sendAudio: () => {},
    vad: scriptVad(hearingFrames()),
    policy: POLICY,
    transcriber,
    realtime: opts.realtime,
    tts,
    guide: GUIDE,
    calls,
    trace: (e) => traces.push(e),
    logSession: (e) => phases.push(e),
    logTurn: (e) => turns.push(e),
  });
  return { live, calls, traces, transcriptions, phases, texts: synthesized, turns };
}

function callerHistory(calls: CallStore, callSid: string): string[] {
  return calls.get(callSid).history.filter((entry) => entry.role === 'caller').map((entry) => entry.text);
}

function transcribeDone(phases: Record<string, unknown>[]): Record<string, unknown> | undefined {
  return phases.find((entry) => entry.phase === 'transcribe' && entry.event === 'done');
}

describe('live commit-time STT hedge', () => {
  it('starts the REST decode at commit and uses it when the realtime final is empty', async () => {
    const order: string[] = [];
    let releaseRest!: (tx: Transcription) => void;
    const restGate = new Promise<Transcription>((resolve) => {
      releaseRest = resolve;
    });
    const h = hedgedSession('CAhedge1', {
      realtime: new FakeRealtime(async () => {
        order.push('final');
        return { text: '', noSpeech: true };
      }),
      transcriber: {
        transcribe: async () => {
          order.push('rest');
          h.transcriptions.push('rest');
          return restGate;
        },
      },
    });
    for (let i = 0; i < 100; i++) await h.live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
    await waitFor(() => h.transcriptions.length === 1, 'the hedge decode starts at commit');
    assert.deepEqual(order, ['rest', 'final'], 'REST starts no later than the commit');
    assert.equal(callerHistory(h.calls, 'CAhedge1').length, 0, 'the empty final waits for its hedge');
    releaseRest({ text: 'rest words', noSpeech: false });
    await waitFor(() => callerHistory(h.calls, 'CAhedge1').length === 1, 'the hedged turn');
    assert.deepEqual(callerHistory(h.calls, 'CAhedge1'), ['rest words']);
    assert.equal(traced(h.traces, 'stt', 'hedge-start').length, 1);
    assert.equal(traced(h.traces, 'stt', 'hedge-win').length, 1);
    assert.equal(transcribeDone(h.phases)?.['source'], 'realtime-empty-rest');
  });

  it('never lets the REST hedge replace a non-empty realtime final', async () => {
    const h = hedgedSession('CAhedge2', {
      realtime: new FakeRealtime(async () => ({ text: 'direct words', noSpeech: false })),
      transcriber: {
        transcribe: async () => {
          h.transcriptions.push('rest');
          return { text: 'rest words', noSpeech: false };
        },
      },
    });
    await feed(h.live, 100);
    await waitFor(() => callerHistory(h.calls, 'CAhedge2').length === 1, 'the realtime turn');
    assert.deepEqual(callerHistory(h.calls, 'CAhedge2'), ['direct words']);
    assert.equal(h.transcriptions.length, 1, 'the hedge decode still started at commit');
    assert.equal(traced(h.traces, 'stt', 'hedge-start').length, 1);
    assert.equal(traced(h.traces, 'stt', 'hedge-lost').length, 1);
    assert.equal(traced(h.traces, 'stt', 'hedge-win').length, 0);
    assert.equal(transcribeDone(h.phases)?.['source'], 'realtime');
  });

  it('does not let an empty REST hedge result preempt a non-empty final still in flight', async () => {
    let releaseFinal!: (tx: Transcription) => void;
    const final = new Promise<Transcription>((resolve) => {
      releaseFinal = resolve;
    });
    const h = hedgedSession('CAhedge3', {
      realtime: new FakeRealtime(() => final),
      transcriber: {
        transcribe: async () => {
          h.transcriptions.push('rest');
          return { text: '', noSpeech: true };
        },
      },
    });
    for (let i = 0; i < 100; i++) await h.live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
    await waitFor(() => h.transcriptions.length === 1, 'the hedge decode returns empty first');
    assert.equal(callerHistory(h.calls, 'CAhedge3').length, 0, 'the Turn waits for the final');
    releaseFinal({ text: 'late realtime words', noSpeech: false });
    await waitFor(() => callerHistory(h.calls, 'CAhedge3').length === 1, 'the realtime final');
    assert.deepEqual(callerHistory(h.calls, 'CAhedge3'), ['late realtime words']);
    assert.equal(traced(h.traces, 'stt', 'hedge-win').length, 0);
    assert.equal(traced(h.traces, 'stt', 'hedge-lost').length, 1);
  });

  it('resolves an empty-final Turn in about max(final, REST), not final + REST', async () => {
    const finalDelayMs = 50;
    const restDelayMs = 300;
    const h = hedgedSession('CAhedge4', {
      realtime: new FakeRealtime(
        () => new Promise<Transcription>((resolve) => setTimeout(() => resolve({ text: '', noSpeech: true }), finalDelayMs)),
      ),
      transcriber: {
        transcribe: async () => {
          h.transcriptions.push('rest');
          await delay(restDelayMs);
          return { text: 'rest words', noSpeech: false };
        },
      },
    });
    for (let i = 0; i < 100; i++) await h.live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
    const started = Date.now();
    await waitFor(() => callerHistory(h.calls, 'CAhedge4').length === 1, 'the hedged turn');
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= restDelayMs - 20, `waits for the in-flight REST decode (${elapsed}ms)`);
    assert.ok(elapsed < finalDelayMs + restDelayMs - 40, `must not pay final + REST (${elapsed}ms)`);
  });

  it('falls back to REST when the realtime final fails', async () => {
    const h = hedgedSession('CAhedge5', {
      realtime: new FakeRealtime(() => Promise.reject(new Error('realtime-final-timeout'))),
      transcriber: {
        transcribe: async () => {
          h.transcriptions.push('rest');
          return { text: 'rest words', noSpeech: false };
        },
      },
    });
    await feed(h.live, 100);
    await waitFor(() => callerHistory(h.calls, 'CAhedge5').length === 1, 'the REST turn');
    assert.deepEqual(callerHistory(h.calls, 'CAhedge5'), ['rest words']);
    assert.equal(h.transcriptions.length, 1, 'the commit-time hedge is the only decode');
    assert.equal(transcribeDone(h.phases)?.['source'], 'rest');
  });

  it('preserves a non-empty realtime final when the REST hedge errors', async () => {
    const h = hedgedSession('CAhedge6', {
      realtime: new FakeRealtime(async () => ({ text: 'direct words', noSpeech: false })),
      transcriber: {
        transcribe: async () => {
          h.transcriptions.push('rest');
          throw new Error('rest-boom');
        },
      },
    });
    await feed(h.live, 100);
    await waitFor(() => callerHistory(h.calls, 'CAhedge6').length === 1, 'the realtime turn');
    assert.deepEqual(callerHistory(h.calls, 'CAhedge6'), ['direct words']);
    assert.equal(transcribeDone(h.phases)?.['source'], 'realtime');
  });

  it('reaches the miss path when both the final and the REST hedge are empty', async () => {
    const h = hedgedSession('CAhedge7', {
      realtime: new FakeRealtime(async () => ({ text: '', noSpeech: true })),
      transcriber: {
        transcribe: async () => {
          h.transcriptions.push('rest');
          return { text: '', noSpeech: true };
        },
      },
    });
    await feed(h.live, 100);
    await h.live.flush();
    assert.equal(callerHistory(h.calls, 'CAhedge7').length, 0, 'nothing reaches history');
    assert.equal(h.turns.length, 1);
    assert.equal(h.turns[0]!.miss, true, 'the Turn is a miss');
    assert.ok(h.texts.some((text) => /say that again/.test(text)), 'the Caller is reprompted');
  });

  it('starts the critical-field second decode while the realtime final is pending', async () => {
    let releaseFinal!: (tx: Transcription) => void;
    const pendingFinal = new Promise<Transcription>((resolve) => {
      releaseFinal = resolve;
    });
    const realtime = new ScriptRealtime([
      async () => ({ text: 'book Wednesday', noSpeech: false }),
      () => pendingFinal,
    ]);
    const secondCalls: string[] = [];
    const calls = new CallStore();
    const { tts } = stubTts();
    const live = new LiveCallSession({
      identity: { callSid: 'CAsecond1', streamSid: 'MZsecond1' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50), ...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: { transcribe: async () => ({ text: 'rest', noSpeech: false }) },
      realtime,
      secondOpinion: {
        transcribe: async () => {
          secondCalls.push('call');
          return { text: 'my name is Rahul', noSpeech: false };
        },
      },
      tts,
      guide: GUIDE,
      availability: AVAILABILITY_SLOT,
      calls,
    });
    await feed(live, 100);
    assert.equal(live.state.phase, 'collecting-patient');

    for (let i = 0; i < 100; i++) await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
    await waitFor(() => secondCalls.length === 1, 'the second decode starts');
    releaseFinal({ text: 'my name is Rahul', noSpeech: false });
    await live.flush();
    assert.deepEqual(callerHistory(calls, 'CAsecond1'), ['book Wednesday', 'my name is Rahul']);
  });

  it('does not commit a critical field when the second decode disagrees', async () => {
    const realtime = new ScriptRealtime([
      async () => ({ text: 'book Wednesday', noSpeech: false }),
      async () => ({ text: 'my number is 9876543210', noSpeech: false }),
    ]);
    const calls = new CallStore();
    const turns: { excerpt: string; reply: string; miss: boolean }[] = [];
    const { tts } = stubTts();
    const live = new LiveCallSession({
      identity: { callSid: 'CAsecond2', streamSid: 'MZsecond2' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50), ...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: { transcribe: async () => ({ text: 'rest', noSpeech: false }) },
      realtime,
      secondOpinion: { transcribe: async () => ({ text: 'my number is 1234567890', noSpeech: false }) },
      tts,
      guide: GUIDE,
      availability: AVAILABILITY_SLOT,
      calls,
      logTurn: (e) => turns.push({ excerpt: e.excerpt, reply: e.reply, miss: e.miss }),
    });
    await feed(live, 100);
    await feed(live, 100);
    assert.equal(live.state.patient.phone, undefined, 'the disagreed number never enters dialogue state');
    assert.equal(live.state.phase, 'collecting-patient');
    assert.equal(turns.length, 2);
    assert.equal(turns[1]!.miss, true);
    assert.match(turns[1]!.reply, /make sure/);
    assert.deepEqual(callerHistory(calls, 'CAsecond2'), ['book Wednesday', 'my number is 9876543210']);
  });

  it('verifies a critical field named outside a collecting phase without committing it', async () => {
    const realtime = new ScriptRealtime([
      async () => ({ text: 'my number is 9876543210', noSpeech: false }),
    ]);
    const calls = new CallStore();
    const turns: { reply: string; miss: boolean }[] = [];
    const { tts } = stubTts();
    const live = new LiveCallSession({
      identity: { callSid: 'CAsecond3', streamSid: 'MZsecond3' },
      sendAudio: () => {},
      vad: scriptVad(hearingFrames()),
      policy: POLICY,
      transcriber: { transcribe: async () => ({ text: 'rest', noSpeech: false }) },
      realtime,
      secondOpinion: { transcribe: async () => ({ text: 'my number is 1234567890', noSpeech: false }) },
      tts,
      guide: GUIDE,
      calls,
      logTurn: (e) => turns.push({ reply: e.reply, miss: e.miss }),
    });
    await feed(live, 100);
    assert.equal(live.state.patient.phone, undefined);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.miss, true);
  });

  it('commits the agreed critical field when the second decode matches', async () => {
    const realtime = new ScriptRealtime([
      async () => ({ text: 'my number is 9876543210', noSpeech: false }),
    ]);
    const calls = new CallStore();
    const turns: { reply: string; miss: boolean }[] = [];
    const { tts } = stubTts();
    const live = new LiveCallSession({
      identity: { callSid: 'CAsecond4', streamSid: 'MZsecond4' },
      sendAudio: () => {},
      vad: scriptVad(hearingFrames()),
      policy: POLICY,
      transcriber: { transcribe: async () => ({ text: 'rest', noSpeech: false }) },
      realtime,
      secondOpinion: { transcribe: async () => ({ text: 'my number is 9876543210', noSpeech: false }) },
      tts,
      guide: GUIDE,
      calls,
      logTurn: (e) => turns.push({ reply: e.reply, miss: e.miss }),
    });
    await feed(live, 100);
    assert.equal(live.state.patient.phone, '9876543210');
    assert.equal(turns.length, 0, 'agreement never reprompts');
  });

  it('falls back to phrase TTS when the streaming socket is unavailable', async () => {
    const synths: string[] = [];
    const tts: Tts = {
      synthesize: async (text: string) => {
        synths.push(text);
        return { audio: Buffer.from([0xff]) };
      },
      begin: () => {
        throw new Error('tts-stream-unavailable');
      },
    };
    const assistant: Assistant = {
      reply: async () => ({ text: '', endCall: false }),
      replyStream: async function* () {
        yield 'Here is the answer you asked for.';
      },
    };
    const calls = new CallStore();
    const live = new LiveCallSession({
      identity: { callSid: 'CAttsfallback', streamSid: 'MZttsfallback' },
      sendAudio: () => {},
      vad: scriptVad(hearingFrames()),
      policy: POLICY,
      transcriber: { transcribe: async () => ({ text: 'what are your hours', noSpeech: false }) },
      tts,
      guide: GUIDE,
      assistant,
      calls,
    });
    await feed(live, 100);
    assert.ok(synths.some((text) => text.includes('answer you asked')), synths.join(' | '));
    assert.equal(live.isClosed, false, 'a TTS outage must not hang up the call');
    assert.deepEqual(
      calls.get('CAttsfallback').history.map((entry) => entry.text),
      ['what are your hours', 'Here is the answer you asked for.'],
    );
  });

  it('feeds the first clause to TTS before the model finishes the reply', async () => {
    const pushes: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const assistant: Assistant = {
      reply: async () => ({ text: '', endCall: false }),
      replyStream: async function* () {
        yield 'Hi there, ';
        await gate;
        yield 'thanks for calling Maple Clinic.';
      },
    };
    const tts: Tts = {
      synthesize: async (text) => ({ audio: Buffer.from([0xff]) }),
      begin: () => ({
        generation: 1,
        pushText: (text: string) => pushes.push(text),
        finishText: () => {},
        audio: async function* () {},
        cancel: () => {},
      }),
    };
    const live = new LiveCallSession({
      identity: { callSid: 'CAfirstphrase', streamSid: 'MZfirstphrase' },
      sendAudio: () => {},
      vad: scriptVad(hearingFrames()),
      policy: POLICY,
      transcriber: { transcribe: async () => ({ text: 'hello', noSpeech: false }) },
      tts,
      guide: GUIDE,
      assistant,
      calls: new CallStore(),
    });
    for (let i = 0; i < 100; i++) await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
    await waitFor(() => pushes.length >= 1, 'the first clause reaches TTS');
    assert.equal(pushes[0], 'Hi there, ');
    release();
    await live.flush();
    assert.ok(pushes.some((text) => text.includes('thanks for calling')), pushes.join(' | '));
  });
});

describe('live latency instrumentation', () => {
  it('traces the trailing silence that preceded the endpoint', async () => {
    const traces: TraceEvent[] = [];
    const { tts } = stubTts();
    const live = new LiveCallSession({
      identity: { callSid: 'CAlat1', streamSid: 'MZlat1' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: { transcribe: async () => ({ text: 'what are your hours', noSpeech: false }) },
      tts,
      guide: GUIDE,
      calls: new CallStore(),
      trace: (e) => traces.push(e),
    });
    await feed(live, 100);
    const endpoint = traced(traces, 'vad', 'endpoint')[0];
    assert.ok(endpoint, 'the endpoint is traced');
    assert.equal(endpoint.trailingSilenceMs, 500, 'no partials: the fixed 500 ms floor owns the boundary');
  });

  it('traces the first outbound frame once per reply generation', async () => {
    const traces: TraceEvent[] = [];
    const { tts } = stubTts(3);
    const chunks: Buffer[] = [];
    const live = new LiveCallSession({
      identity: { callSid: 'CAlat2', streamSid: 'MZlat2' },
      sendAudio: (audio) => chunks.push(audio),
      vad: scriptVad(silence(10)),
      policy: POLICY,
      transcriber: { transcribe: async () => ({ text: 'hi', noSpeech: false }) },
      tts,
      guide: GUIDE,
      calls: new CallStore(),
      trace: (e) => traces.push(e),
    });
    await live.speak('hello there');
    const first = traced(traces, 'call', 'first-outbound');
    assert.equal(first.length, 1);
    assert.equal(first[0]!.generation, 1);
    assert.equal(chunks.length, 3, 'every synthesized chunk still reaches the transport');

    await live.speak('second reply');
    const all = traced(traces, 'call', 'first-outbound');
    assert.equal(all.length, 2);
    assert.equal(all[1]!.generation, 2);
  });
});
