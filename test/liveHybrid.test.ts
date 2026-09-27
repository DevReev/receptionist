import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CallStore } from '../src/calls.ts';
import { LiveCallSession } from '../src/live.ts';
import type { Utterance } from '../src/endpoint.ts';
import type { Assistant, Transcription } from '../src/app.ts';
import type { PartialTranscript, RealtimeStt } from '../src/realtimeStt.ts';
import { OpenAiRealtimeStt } from '../src/openaiRealtime.ts';
import type { RealtimeSocket } from '../src/ws.ts';
import { FRAME_BYTES, SILENCE_FRAME, SPEECH_FRAME, byteVad } from './fakeStream.ts';
import type { Tts } from '../src/tts.ts';

const POLICY = { silenceMs: 5000, minSpeechMs: 300, maxUtteranceMs: 30000, threshold: 0.5, latchDipMs: 200 };
const GUIDE = { raw: '# Clinic Guide — Maple Clinic\n', name: 'Maple Clinic' };
const AVAILABILITY =
  'AVAILABILITY (fetched live — only these slots exist)\n- 2026-09-30 09:30 Appointment with Bob Gowda at Bobby Clinic';

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

/** Channel with scripted partials; the local detector owns the boundaries. */
class FakeHybridStt implements RealtimeStt {
  readonly partials: boolean;
  finalizeCalls = 0;
  speechStartCalls = 0;
  private partialHandler: ((partial: PartialTranscript) => void) | null = null;
  private readonly finals: Transcription[];

  constructor(opts: { finals?: Transcription[]; partials?: boolean } = {}) {
    this.finals = opts.finals ?? [];
    this.partials = opts.partials ?? true;
  }

  get partialsRegistered(): boolean {
    return this.partialHandler !== null;
  }

  pushAudio(): void {}

  speechStart(): void {
    this.speechStartCalls += 1;
  }

  finalize(): Promise<Transcription> {
    this.finalizeCalls += 1;
    const tx = this.finals.shift();
    return tx ? Promise.resolve(tx) : Promise.reject(new Error('realtime-not-streaming'));
  }

  onPartial(handler: (partial: PartialTranscript) => void): void {
    this.partialHandler = handler;
  }

  partial(text: string): void {
    this.partialHandler?.({ text });
  }

  close(): void {}
}

/** Socket fake for the real adapter: drives deltas from the test, no network. */
class ScriptedSocket implements RealtimeSocket {
  readonly sent: string[] = [];
  private openCb: (() => void) | null = null;
  private messageCb: ((data: string) => void) | null = null;
  private closeCb: ((code: number, reason: string) => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {}

  onOpen(cb: () => void): void {
    this.openCb = cb;
  }

  onMessage(cb: (data: string) => void): void {
    this.messageCb = cb;
  }

  onClose(cb: (code: number, reason: string) => void): void {
    this.closeCb = cb;
  }

  onError(cb: (err: Error) => void): void {
    this.errorCb = cb;
  }

  peerOpen(): void {
    this.openCb?.();
  }

  peerMessage(payload: unknown): void {
    this.messageCb?.(JSON.stringify(payload));
  }

  commits(): number {
    return this.sent.filter((entry) => (JSON.parse(entry) as { type?: string }).type === 'input_audio_buffer.commit').length;
  }
}

function liveSession(opts: {
  callSid: string;
  stt: RealtimeStt;
  transcriberText?: string;
}): { live: LiveCallSession; texts: string[] } {
  const { tts, texts } = stubTts();
  const live = new LiveCallSession({
    identity: { callSid: opts.callSid, streamSid: `MZ${opts.callSid}` },
    sendAudio: () => {},
    vad: byteVad,
    policy: POLICY,
    transcriber: { transcribe: async () => ({ text: opts.transcriberText ?? 'rest', noSpeech: false }) },
    realtime: opts.stt,
    tts,
    guide: GUIDE,
    availability: AVAILABILITY,
    assistant,
    calls: new CallStore(),
  });
  return { live, texts };
}

describe('live hybrid detector (ticket 07)', () => {
  it('ends the Turn at the adaptive floor', async () => {
    const stt = new FakeHybridStt({
      finals: [{ text: 'what are your hours', noSpeech: false }],
    });
    const { live, texts } = liveSession({ callSid: 'CAhyb1', stt });

    for (let i = 0; i < 15; i += 1) await live.receiveAudio(SPEECH_FRAME);
    stt.partial('what are your hours');
    assert.equal(stt.partialsRegistered, true, 'the declared partial channel is subscribed');
    for (let i = 0; i < 14; i += 1) await live.receiveAudio(SILENCE_FRAME);
    assert.equal(stt.speechStartCalls, 1, 'the local latch opens the utterance');
    assert.equal(stt.finalizeCalls, 0, '280 ms of trailing silence is still inside the floor');
    await live.receiveAudio(SILENCE_FRAME);
    await live.flush();
    assert.equal(stt.finalizeCalls, 1, '300 ms of trailing silence ends the Turn');
    await waitFor(() => live.currentPhase === 'LISTENING', 'the reply');
    assert.ok(texts.some((text) => /Monday to Friday/.test(text)));
    live.close('test');
  });

  it('raises the boundary floor while the dialogue collects the Patient name', async () => {
    const stt = new FakeHybridStt({
      finals: [
        { text: 'book Wednesday morning', noSpeech: false },
        { text: 'John Smith', noSpeech: false },
      ],
    });
    const { live, texts } = liveSession({ callSid: 'CAhyb2', stt });

    // Turn 1: picks a Slot and moves the dialogue into collecting-patient.
    for (let i = 0; i < 15; i += 1) await live.receiveAudio(SPEECH_FRAME);
    stt.partial('book Wednesday morning');
    for (let i = 0; i < 15; i += 1) await live.receiveAudio(SILENCE_FRAME);
    await live.flush();
    await waitFor(() => live.currentPhase === 'LISTENING', 'the name question');
    assert.ok(texts.some((text) => /name/i.test(text)));
    assert.equal(live.state.phase, 'collecting-patient');

    // Turn 2: a dictated name survives a 400 ms pause; the 600 ms floor ends it.
    for (let i = 0; i < 15; i += 1) await live.receiveAudio(SPEECH_FRAME);
    stt.partial('John Smith');
    for (let i = 0; i < 29; i += 1) await live.receiveAudio(SILENCE_FRAME);
    assert.equal(stt.finalizeCalls, 1, '580 ms of silence is still inside the collecting floor');
    await live.receiveAudio(SILENCE_FRAME);
    await live.flush();
    assert.equal(stt.finalizeCalls, 2, '600 ms of silence ends the dictated field');
    assert.equal(live.state.patient.name, 'John Smith');
    live.close('test');
  });

  it('releases a stale partial at the staleness budget instead of the emergency cap', async () => {
    const stt = new FakeHybridStt({ finals: [{ text: 'and then', noSpeech: false }] });
    const { live } = liveSession({ callSid: 'CAhyb3', stt });
    for (let i = 0; i < 15; i += 1) await live.receiveAudio(SPEECH_FRAME);
    stt.partial('I would like to book an appointment and');
    for (let i = 0; i < 65; i += 1) await live.receiveAudio(SILENCE_FRAME);
    assert.equal(stt.finalizeCalls, 0, 'the continuation cue holds well past the floor');
    await live.receiveAudio(SILENCE_FRAME);
    await live.flush();
    assert.equal(stt.finalizeCalls, 1, 'stale evidence releases before 1500 ms of trailing silence');
    live.close('test');
  });

  it('holds grouped digits while the dialogue collects the Patient phone', async () => {
    const stt = new FakeHybridStt({
      finals: [
        { text: 'book Wednesday morning', noSpeech: false },
        { text: 'John Smith', noSpeech: false },
        { text: '9876543210', noSpeech: false },
      ],
    });
    const { live, texts } = liveSession({ callSid: 'CAhyb6', stt });

    // Turn 1: picks a Slot and moves the dialogue into collecting-patient.
    for (let i = 0; i < 15; i += 1) await live.receiveAudio(SPEECH_FRAME);
    stt.partial('book Wednesday morning');
    for (let i = 0; i < 15; i += 1) await live.receiveAudio(SILENCE_FRAME);
    await live.flush();
    await waitFor(() => live.currentPhase === 'LISTENING', 'the name question');
    assert.ok(texts.some((text) => /name/i.test(text)));
    assert.equal(live.state.phase, 'collecting-patient');

    // Turn 2: the dictated name endpoints at the 600 ms floor (no phone flag yet).
    for (let i = 0; i < 15; i += 1) await live.receiveAudio(SPEECH_FRAME);
    stt.partial('John Smith');
    for (let i = 0; i < 29; i += 1) await live.receiveAudio(SILENCE_FRAME);
    assert.equal(stt.finalizeCalls, 1, '580 ms of silence is still inside the collecting floor');
    await live.receiveAudio(SILENCE_FRAME);
    await live.flush();
    await waitFor(() => live.currentPhase === 'LISTENING', 'the phone question');
    assert.ok(texts.some((text) => /mobile number/i.test(text)));
    assert.equal(live.state.patient.name, 'John Smith');

    // Turn 3: grouped digits hold past the floor; the completed number endpoints.
    for (let i = 0; i < 15; i += 1) await live.receiveAudio(SPEECH_FRAME);
    stt.partial('98765');
    for (let i = 0; i < 39; i += 1) await live.receiveAudio(SILENCE_FRAME);
    assert.equal(stt.finalizeCalls, 2, '780 ms of silence never endpoints mid-number');
    stt.partial('9876543210');
    await live.receiveAudio(SILENCE_FRAME);
    await live.flush();
    assert.equal(stt.finalizeCalls, 3, 'the completed number endpoints');
    assert.equal(live.state.patient.phone, '9876543210');
    live.close('test');
  });

  it('uses the declared partial channel, never the onPartial callback, to pick the floor', async () => {
    // The provider exposes an onPartial method but declares no partial channel:
    // the session must not subscribe to it or trust partial evidence.
    const stt = new FakeHybridStt({
      partials: false,
      finals: [{ text: 'what are your hours', noSpeech: false }],
    });
    const { live } = liveSession({ callSid: 'CAhyb4', stt });

    for (let i = 0; i < 15; i += 1) await live.receiveAudio(SPEECH_FRAME);
    stt.partial('what are your hours');
    assert.equal(stt.partialsRegistered, false, 'a declared-no-partials provider is never subscribed');
    for (let i = 0; i < 24; i += 1) await live.receiveAudio(SILENCE_FRAME);
    assert.equal(stt.finalizeCalls, 0, '480 ms of trailing silence is inside the no-partials floor');
    await live.receiveAudio(SILENCE_FRAME);
    await live.flush();
    assert.equal(stt.finalizeCalls, 1, 'the fixed no-partials floor owns the boundary');
    live.close('test');
  });

  it('holds an incomplete partial past the adaptive floor until it completes', async () => {
    const stt = new FakeHybridStt({
      finals: [{ text: 'I would like to book an appointment for Monday', noSpeech: false }],
    });
    const { live } = liveSession({ callSid: 'CAhyb5', stt });

    for (let i = 0; i < 15; i += 1) await live.receiveAudio(SPEECH_FRAME);
    stt.partial('I would like to book an appointment for');
    for (let i = 0; i < 19; i += 1) await live.receiveAudio(SILENCE_FRAME);
    assert.equal(stt.finalizeCalls, 0, 'the continuation cue holds past the 300 ms adaptive floor');
    for (let i = 0; i < 10; i += 1) await live.receiveAudio(SPEECH_FRAME);
    stt.partial('I would like to book an appointment for Monday');
    for (let i = 0; i < 14; i += 1) await live.receiveAudio(SILENCE_FRAME);
    assert.equal(stt.finalizeCalls, 0, '280 ms of trailing silence is still inside the floor');
    await live.receiveAudio(SILENCE_FRAME);
    await live.flush();
    assert.equal(stt.finalizeCalls, 1, 'the completed thought fires at the adaptive floor');
    live.close('test');
  });

  it('runs semantic boundaries for a session built on the OpenAI Realtime adapter', async () => {
    const socket = new ScriptedSocket();
    const stt = new OpenAiRealtimeStt({
      config: {
        apiKey: 'sk-openai',
        url: 'wss://api.openai.com/v1/realtime?intent=transcription',
        model: 'gpt-live-transcribe',
        delay: 'minimal',
      },
      connect: () => socket,
    });
    socket.peerOpen();
    const { live } = liveSession({ callSid: 'CAoai1', stt });

    for (let i = 0; i < 15; i += 1) await live.receiveAudio(SPEECH_FRAME);
    socket.peerMessage({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item_1',
      delta: 'what are your hours',
    });
    for (let i = 0; i < 14; i += 1) await live.receiveAudio(SILENCE_FRAME);
    assert.equal(socket.commits(), 0, '280 ms of trailing silence is inside the adaptive floor');
    await live.receiveAudio(SILENCE_FRAME);
    await waitFor(() => socket.commits() === 1, 'the adapter commit');
    socket.peerMessage({ type: 'input_audio_buffer.committed', item_id: 'item_1' });
    socket.peerMessage({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_1',
      transcript: 'what are your hours',
    });
    await live.flush();
    assert.equal(socket.commits(), 1, 'the adapter declaration puts the semantic boundary in charge');
    await waitFor(() => live.currentPhase === 'LISTENING', 'the reply');
    live.close('test');
  });
});
