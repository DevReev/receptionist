import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CallStore } from '../src/calls.ts';
import { LiveCallSession } from '../src/live.ts';
import type { Vad } from '../src/endpoint.ts';
import type { Assistant, Transcriber, Transcription, TurnEvent } from '../src/app.ts';
import type { PartialTranscript, RealtimeEndpointing, RealtimeStt, VadEvent } from '../src/sarvamRealtime.ts';
import type { Tts } from '../src/tts.ts';
import type { TraceEvent } from '../src/trace.ts';

const FRAME_BYTES = 160; // 20 ms of 8 kHz mulaw.
const SPEECH_FRAME = Buffer.alloc(FRAME_BYTES, 0x11);
const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES, 0xff);
const POLICY = { silenceMs: 5000, minSpeechMs: 300, maxUtteranceMs: 30000, threshold: 0.5, latchDipMs: 200 };
const GUIDE = { raw: '# Clinic Guide — Maple Clinic\n', name: 'Maple Clinic' };
const GRACE_FRAMES = 60; // 1200 ms of local trailing silence.

/** The frame bytes are the script: 0x11 is audible speech, 0xFF is mu-law silence. */
const byteVad: Vad = {
  score: async (pcm) => (pcm.every((sample) => sample === 0) ? 0.05 : 0.9),
  reset: () => {},
};

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function stubTts(): { tts: Tts; texts: string[] } {
  const texts: string[] = [];
  const tts: Tts = {
    synthesize: async (text: string) => {
      texts.push(text);
      return { audio: Buffer.alloc(FRAME_BYTES, 0xff) };
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

/** Provider VAD channel that can stall: boundaries arrive only when scripted. */
class FakeStallingStt implements RealtimeStt {
  endpointing: RealtimeEndpointing = 'vad';
  finalizeCalls = 0;
  speechStartCalls = 0;
  abandonCalls = 0;
  setEndpointingCalls: RealtimeEndpointing[] = [];
  /** A final that landed without its boundary; handed back on abandon. */
  earlyFinal?: Transcription;
  private handler: ((event: VadEvent) => void) | null = null;
  private readonly finals: Transcription[];

  constructor(finals: Transcription[] = []) {
    this.finals = finals;
  }

  pushAudio(): void {}

  speechStart(): void {
    this.speechStartCalls += 1;
  }

  finalize(): Promise<Transcription> {
    const tx = this.finals.shift();
    this.finalizeCalls += 1;
    return tx ? Promise.resolve(tx) : Promise.reject(new Error('sarvam-realtime-not-streaming'));
  }

  onVadEvent(handler: (event: VadEvent) => void): void {
    this.handler = handler;
  }

  emit(event: VadEvent): void {
    this.handler?.(event);
  }

  setEndpointing(mode: RealtimeEndpointing): void {
    this.setEndpointingCalls.push(mode);
    if (mode === 'manual') this.endpointing = 'manual';
  }

  /** Releases the provider utterance the local detector ended. */
  abandonUtterance(): Transcription | undefined {
    this.abandonCalls += 1;
    const final = this.earlyFinal;
    this.earlyFinal = undefined;
    return final;
  }

  close(): void {}
}

interface Harness {
  live: LiveCallSession;
  stt: FakeStallingStt;
  turns: TurnEvent[];
  traces: TraceEvent[];
  texts: string[];
  restCalls: () => number;
}

function liveSession(callSid: string, stt: FakeStallingStt): Harness {
  const { tts, texts } = stubTts();
  const turns: TurnEvent[] = [];
  const traces: TraceEvent[] = [];
  let restCalls = 0;
  const transcriber: Transcriber = {
    transcribe: async () => {
      restCalls += 1;
      return { text: 'rest transcript', noSpeech: false };
    },
  };
  const live = new LiveCallSession({
    identity: { callSid, streamSid: `MZ${callSid}` },
    sendAudio: () => {},
    vad: byteVad,
    policy: POLICY,
    transcriber,
    realtime: stt,
    turnDetection: 'sarvam',
    tts,
    guide: GUIDE,
    assistant,
    calls: new CallStore(),
    logTurn: (e) => turns.push(e),
    trace: (e) => traces.push(e),
  });
  return { live, stt, turns, traces, texts, restCalls: () => restCalls };
}

/** One provider-heard utterance that never gets its `speech_end`. */
async function stallOnce(h: Harness): Promise<void> {
  h.stt.emit('speech_start');
  for (let i = 0; i < 15; i += 1) await h.live.receiveAudio(SPEECH_FRAME);
  for (let i = 0; i < GRACE_FRAMES; i += 1) await h.live.receiveAudio(SILENCE_FRAME);
  await h.live.flush();
}

/** One provider-heard utterance with both boundaries. */
async function providerTurn(h: Harness): Promise<void> {
  h.stt.emit('speech_start');
  for (let i = 0; i < 15; i += 1) await h.live.receiveAudio(SPEECH_FRAME);
  h.stt.emit('speech_end');
  await h.live.receiveAudio(SILENCE_FRAME);
  await h.live.flush();
}

function stallTraces(traces: TraceEvent[]): TraceEvent[] {
  return traces.filter((e) => e.component === 'call' && e.event === 'stall');
}

function fallbackTraces(traces: TraceEvent[]): TraceEvent[] {
  return traces.filter((e) => e.component === 'stt' && e.event === 'fallback');
}

function switchTraces(traces: TraceEvent[]): TraceEvent[] {
  return traces.filter((e) => e.component === 'call' && e.event === 'detector-switch');
}

describe('live provider stall guard', () => {
  it('completes a stalled Turn through REST transcription with no hang', async () => {
    const stt = new FakeStallingStt();
    const h = liveSession('CAstall1', stt);
    await stallOnce(h);

    assert.equal(stt.finalizeCalls, 0, 'a stalled Turn does not wait on a final that never comes');
    assert.equal(stt.abandonCalls, 1, 'the orphaned provider utterance is released');
    assert.equal(h.restCalls(), 1, 'transcription falls back to the REST path');
    assert.equal(h.turns.length, 1);
    assert.equal(h.turns[0]!.excerpt, 'rest transcript');
    assert.match(h.turns[0]!.reply, /Monday to Friday/, 'the Caller hears the reply');
    await waitFor(() => h.live.currentPhase === 'LISTENING', 'listening after the reply');

    assert.equal(stallTraces(h.traces).length, 1, 'the stall is traced');
    assert.equal(stallTraces(h.traces)[0]!['trailingSilenceMs'], 1200);
    assert.equal(stallTraces(h.traces)[0]!['speechMs'], 300);
    assert.equal(stallTraces(h.traces)[0]!['graceMs'], 1200);
    assert.equal(fallbackTraces(h.traces).length, 1, 'the REST fallback is traced');
    assert.equal(fallbackTraces(h.traces)[0]!['source'], 'rest');
    assert.equal(fallbackTraces(h.traces)[0]!['reason'], 'provider-stall');
    assert.equal(fallbackTraces(h.traces)[0]!['turn'], 1);
    h.live.close('test');
  });

  it('switches the session to the local detector after two consecutive stalls', async () => {
    const stt = new FakeStallingStt([{ text: 'local transcript', noSpeech: false }]);
    const h = liveSession('CAstall2', stt);
    await stallOnce(h);
    await waitFor(() => h.live.currentPhase === 'LISTENING', 'listening after stall one');
    assert.equal(switchTraces(h.traces).length, 0, 'one stall does not switch the mode');

    await stallOnce(h);
    await waitFor(() => h.live.currentPhase === 'LISTENING', 'listening after stall two');
    assert.deepEqual(stt.setEndpointingCalls, ['manual'], 'the socket is switched to manual');
    assert.equal(switchTraces(h.traces).length, 1);
    assert.equal(switchTraces(h.traces)[0]!['mode'], 'hybrid');
    assert.equal(switchTraces(h.traces)[0]!['stalls'], 2);

    // A third Turn needs no provider boundary: the local detector owns it.
    for (let i = 0; i < 15; i += 1) await h.live.receiveAudio(SPEECH_FRAME);
    for (let i = 0; i < 15; i += 1) await h.live.receiveAudio(SILENCE_FRAME);
    await h.live.flush();
    assert.equal(stt.speechStartCalls, 1, 'the local latch opens the manual utterance');
    assert.equal(stt.finalizeCalls, 1, 'the detector-owned Turn reads the channel final');
    assert.equal(h.turns.length, 3);
    assert.equal(h.turns[2]!.excerpt, 'local transcript');
    const endpoint = h.traces.filter((e) => e.component === 'vad' && e.event === 'endpoint');
    assert.equal(endpoint[2]!['source'], 'local');
    assert.equal(h.restCalls(), 2, 'only the stalled Turns fell back to REST');
    h.live.close('test');
  });

  it('uses a final that already landed instead of the REST fallback', async () => {
    const stt = new FakeStallingStt();
    stt.earlyFinal = { text: 'delivered final', noSpeech: false };
    const h = liveSession('CAstall4', stt);
    await stallOnce(h);

    assert.equal(h.restCalls(), 0, 'delivered text is not thrown away for REST');
    assert.equal(h.turns.length, 1);
    assert.equal(h.turns[0]!.excerpt, 'delivered final');
    assert.equal(fallbackTraces(h.traces).length, 0, 'no fallback happened');
    assert.equal(stallTraces(h.traces).length, 1, 'the boundary stall is still traced');
    h.live.close('test');
  });

  it('completes a Turn when the provider emits no boundary at all', async () => {
    const stt = new FakeStallingStt();
    const h = liveSession('CAstall5', stt);
    for (let i = 0; i < 15; i += 1) await h.live.receiveAudio(SPEECH_FRAME);
    for (let i = 0; i < GRACE_FRAMES; i += 1) await h.live.receiveAudio(SILENCE_FRAME);
    await h.live.flush();

    assert.equal(h.restCalls(), 1, 'local speech presence alone completes the Turn');
    assert.equal(h.turns.length, 1);
    assert.equal(h.turns[0]!.excerpt, 'rest transcript');
    assert.match(h.turns[0]!.reply, /Monday to Friday/);
    h.live.close('test');
  });

  it('does not switch when stalls are separated by a provider boundary', async () => {
    const stt = new FakeStallingStt([{ text: 'provider transcript', noSpeech: false }]);
    const h = liveSession('CAstall3', stt);
    await stallOnce(h);
    await waitFor(() => h.live.currentPhase === 'LISTENING', 'listening after the stall');
    await providerTurn(h);
    await waitFor(() => h.live.currentPhase === 'LISTENING', 'listening after the provider turn');
    await stallOnce(h);
    await waitFor(() => h.live.currentPhase === 'LISTENING', 'listening after the second stall');

    assert.deepEqual(stt.setEndpointingCalls, [], 'an isolated stall never switches the mode');
    assert.equal(switchTraces(h.traces).length, 0);
    assert.equal(stallTraces(h.traces).length, 2, 'both stalls are still traced');
    assert.equal(stt.finalizeCalls, 1, 'the provider boundary Turn used its final');
    h.live.close('test');
  });
});
