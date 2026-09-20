import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CallStore } from '../src/calls.ts';
import { LiveCallSession } from '../src/live.ts';
import type { Utterance, Vad } from '../src/endpoint.ts';
import type { Assistant, Transcription } from '../src/app.ts';
import type { PartialTranscript, RealtimeStt } from '../src/realtimeStt.ts';
import type { Tts } from '../src/tts.ts';

const FRAME_BYTES = 160; // 20 ms of 8 kHz mulaw.
const SPEECH_FRAME = Buffer.alloc(FRAME_BYTES, 0x11);
const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES, 0xff);
const POLICY = { silenceMs: 5000, minSpeechMs: 300, maxUtteranceMs: 30000, threshold: 0.5, latchDipMs: 200 };
const GUIDE = { raw: '# Clinic Guide — Maple Clinic\n', name: 'Maple Clinic' };
const AVAILABILITY =
  'AVAILABILITY (fetched live — only these slots exist)\n- 2026-09-30 09:30 Appointment with Bob Gowda at Bobby Clinic';

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

/** Channel with scripted partials; the local detector owns the boundaries. */
class FakeHybridStt implements RealtimeStt {
  finalizeCalls = 0;
  speechStartCalls = 0;
  private partialHandler: ((partial: PartialTranscript) => void) | null = null;
  private readonly finals: Transcription[];

  constructor(opts: { finals?: Transcription[] } = {}) {
    this.finals = opts.finals ?? [];
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

function liveSession(opts: {
  callSid: string;
  stt: FakeHybridStt;
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

  it('lets the default 1.5 s emergency cap end a Turn held by an incomplete partial', async () => {
    const stt = new FakeHybridStt({ finals: [{ text: 'and then', noSpeech: false }] });
    const { live } = liveSession({ callSid: 'CAhyb3', stt });
    for (let i = 0; i < 15; i += 1) await live.receiveAudio(SPEECH_FRAME);
    stt.partial('I would like to book an appointment and');
    for (let i = 0; i < 74; i += 1) await live.receiveAudio(SILENCE_FRAME);
    assert.equal(stt.finalizeCalls, 0, 'the continuation cue holds well past the floor');
    await live.receiveAudio(SILENCE_FRAME);
    await live.flush();
    assert.equal(stt.finalizeCalls, 1, '1500 ms of trailing silence emits regardless');
    live.close('test');
  });
});
