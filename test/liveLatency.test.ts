import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CallStore } from '../src/calls.ts';
import { LiveCallSession } from '../src/live.ts';
import type { Assistant, Transcriber, Transcription } from '../src/app.ts';
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
    hedgeMs?: number;
    traces?: TraceEvent[];
    calls?: CallStore;
  },
): { live: LiveCallSession; calls: CallStore; traces: TraceEvent[]; transcriptions: string[] } {
  const calls = opts.calls ?? new CallStore();
  const traces = opts.traces ?? [];
  const transcriptions: string[] = [];
  const { tts } = stubTts();
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
    sttHedgeMs: opts.hedgeMs ?? 0,
    tts,
    guide: GUIDE,
    calls,
    trace: (e) => traces.push(e),
  });
  return { live, calls, traces, transcriptions };
}

function callerHistory(calls: CallStore, callSid: string): string[] {
  return calls.get(callSid).history.filter((entry) => entry.role === 'caller').map((entry) => entry.text);
}

describe('STT route warm-up', () => {
  it('transcribes a throwaway clip on open and leaves no Turn behind', async () => {
    const calls = new CallStore();
    const seen: number[] = [];
    const traces: TraceEvent[] = [];
    const { tts } = stubTts();
    const live = new LiveCallSession({
      identity: { callSid: 'CAwarm', streamSid: 'MZwarm' },
      sendAudio: () => {},
      vad: scriptVad(silence(10)),
      policy: POLICY,
      transcriber: {
        transcribe: async (wav) => {
          seen.push(wav.length);
          return { text: '', noSpeech: true };
        },
      },
      tts,
      guide: GUIDE,
      calls,
      warmTranscriber: true,
      trace: (e) => traces.push(e),
    });
    await live.open();
    await waitFor(() => traced(traces, 'stt', 'warmup-done').length === 1, 'the warm-up completes');
    assert.equal(seen.length, 1);
    assert.ok(seen[0]! > 44, 'the warm-up sends a real WAV, not an empty buffer');
    assert.equal(calls.get('CAwarm').turn, 0);
    assert.equal(calls.get('CAwarm').history.length, 0);
  });
});

describe('local endpointing without partials', () => {
  it('holds a mid-sentence pause when no partial channel exists', async () => {
    const calls = new CallStore();
    const transcriptions: number[] = [];
    const { tts } = stubTts();
    const live = new LiveCallSession({
      identity: { callSid: 'CAhold', streamSid: 'MZhold' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(15), ...speech(50), ...silence(40)]),
      policy: POLICY,
      transcriber: {
        transcribe: async (wav) => {
          transcriptions.push(wav.length);
          return { text: 'whole sentence', noSpeech: false };
        },
      },
      tts,
      guide: GUIDE,
      calls,
    });
    await feed(live, 200);
    assert.equal(transcriptions.length, 1, 'the 300 ms pause must not split the utterance');
    assert.equal(calls.get('CAhold').turn, 1);
  });
});

describe('live hedged STT fallback', () => {
  it('starts REST at the hedge deadline when the realtime final is slow', async () => {
    const h = hedgedSession('CAhedge1', {
      realtime: new FakeRealtime(() => new Promise<Transcription>(() => {})),
      hedgeMs: 20,
    });
    for (let i = 0; i < 100; i++) await h.live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
    await waitFor(() => callerHistory(h.calls, 'CAhedge1').length === 1, 'the hedged turn');
    assert.deepEqual(callerHistory(h.calls, 'CAhedge1'), ['rest words']);
    assert.equal(h.transcriptions.length, 1);
    assert.equal(traced(h.traces, 'stt', 'hedge-start').length, 1);
    assert.equal(traced(h.traces, 'stt', 'hedge-win').length, 1);
  });

  it('never starts REST when the realtime final arrives inside the hedge', async () => {
    const h = hedgedSession('CAhedge2', {
      realtime: new FakeRealtime(async () => ({ text: 'direct words', noSpeech: false })),
      hedgeMs: 1000,
    });
    await feed(h.live, 100);
    assert.deepEqual(callerHistory(h.calls, 'CAhedge2'), ['direct words']);
    assert.equal(h.transcriptions.length, 0);
    assert.equal(traced(h.traces, 'stt', 'hedge-start').length, 0);
  });

  it('uses a late realtime final when it beats the hedged REST decode', async () => {
    let release!: (tx: Transcription) => void;
    const final = new Promise<Transcription>((resolve) => {
      release = resolve;
    });
    const restGates: (() => void)[] = [];
    const h = hedgedSession('CAhedge3', {
      realtime: new FakeRealtime(() => final),
      hedgeMs: 15,
      transcriber: {
        transcribe: async () => {
          await new Promise<void>((resolve) => restGates.push(resolve));
          return { text: 'rest words', noSpeech: false };
        },
      },
    });
    for (let i = 0; i < 100; i++) await h.live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
    await waitFor(() => restGates.length === 1, 'the hedged REST decode starts');
    release({ text: 'late realtime words', noSpeech: false });
    await h.live.flush();
    assert.deepEqual(callerHistory(h.calls, 'CAhedge3'), ['late realtime words']);
    assert.equal(traced(h.traces, 'stt', 'hedge-lost').length, 1);
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
        throw new Error('sarvam-tts-stream-unavailable');
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

  it('uses the hedged REST decode exactly once when the realtime final fails', async () => {
    let failFinal!: (err: Error) => void;
    const final = new Promise<Transcription>((_, reject) => {
      failFinal = reject;
    });
    const h = hedgedSession('CAhedge4', {
      realtime: new FakeRealtime(() => final),
      hedgeMs: 15,
    });
    for (let i = 0; i < 100; i++) await h.live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
    await delay(30);
    failFinal(new Error('sarvam-realtime-final-timeout'));
    await waitFor(() => callerHistory(h.calls, 'CAhedge4').length === 1, 'the REST turn');
    assert.deepEqual(callerHistory(h.calls, 'CAhedge4'), ['rest words']);
    assert.equal(h.transcriptions.length, 1);
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
