import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPhoneDictationComplete } from '../src/dialogue.ts';
import { isSemanticallyComplete } from '../src/hybridDetector.ts';
import { TurnTaking } from '../src/turnTaking.ts';
import { CallStore } from '../src/calls.ts';
import { LiveCallSession } from '../src/live.ts';
import type { Utterance, Vad } from '../src/endpoint.ts';
import type { Assistant, Transcription } from '../src/app.ts';
import type { PartialTranscript, RealtimeStt } from '../src/realtimeStt.ts';
import { FRAME_BYTES, SILENCE_FRAME, SPEECH_FRAME, byteVad } from './fakeStream.ts';
import type { Tts } from '../src/tts.ts';

/**
 * Ticket 14: phone completeness is the dialogue layer's language judgement,
 * not a digit count. A scripted long dictation (country code, regrouped
 * repeats, extension cue) never splits mid-number; a clean complete number
 * endpoints at the normal floor. The old digit ceiling (>13 digits forces
 * "complete") no longer owns the decision.
 */
const LONG_DICTATION = '+91 98765 43210 98765 43210 ext';
const REGROUP_REPEAT = 'my number is 98765 98765';
const COMPLETE_NUMBER = '9876543210';

describe('phone completeness verdict (ticket 14)', () => {
  it('calls a clean 10-digit dictation complete', () => {
    assert.equal(isPhoneDictationComplete(COMPLETE_NUMBER), true);
    assert.equal(isPhoneDictationComplete('my number is 9876543210'), true);
    assert.equal(isPhoneDictationComplete('+91 9876543210'), true);
    assert.equal(isPhoneDictationComplete('nine eight seven six five four three two one zero'), true);
  });

  it('holds short groupings as incomplete', () => {
    assert.equal(isPhoneDictationComplete('98765'), false);
    assert.equal(isPhoneDictationComplete('my number is 98765'), false);
    assert.equal(isPhoneDictationComplete('nine eight seven six five'), false);
  });

  it('holds regrouped repeats instead of counting them twice', () => {
    assert.equal(isPhoneDictationComplete(REGROUP_REPEAT), false);
  });

  it('tolerates a regroup once the rest of the number arrives', () => {
    assert.equal(isPhoneDictationComplete('91 98765 98765 43210'), true);
  });

  it('holds bare extension cues and endpoint a finished extension', () => {
    assert.equal(isPhoneDictationComplete('my number is 9876543210 ext'), false);
    assert.equal(isPhoneDictationComplete('my number is 9876543210 extension'), false);
    assert.equal(isPhoneDictationComplete('my number is 9876543210 ext 123'), true);
  });

  it('holds the scripted long dictation: country code, repeats, extension cue', () => {
    assert.equal(isPhoneDictationComplete(LONG_DICTATION), false);
  });

  it('endpoint a regroup plus a finished extension as one complete number', () => {
    assert.equal(isPhoneDictationComplete('+91 98765 43210 98765 43210 ext 12'), true);
  });

  it('demotes the digit ceiling: over-long dictations hold instead of force-completing', () => {
    assert.equal(isPhoneDictationComplete('1 2 3 4 5 6 7 8 9 0 1 2 3 4 5'), false);
    assert.equal(isPhoneDictationComplete(LONG_DICTATION), false);
  });

  it('holds trailing separators and leaves non-dictations complete', () => {
    assert.equal(isPhoneDictationComplete('9876543210-'), false);
    assert.equal(isPhoneDictationComplete(''), true);
    assert.equal(isPhoneDictationComplete('John Smith'), true);
    assert.equal(isPhoneDictationComplete('I have 2 kids'), true);
  });
});

describe('hybrid detector phone path (ticket 14)', () => {
  it('holds the long dictation while collecting the phone', () => {
    assert.equal(isSemanticallyComplete(LONG_DICTATION, { collectingPhone: true }), false);
    assert.equal(isSemanticallyComplete(REGROUP_REPEAT, { collectingPhone: true }), false);
    assert.equal(isSemanticallyComplete('my number is 9876543210 ext', { collectingPhone: true }), false);
  });

  it('endpoints a complete number at the normal floor while collecting the phone', () => {
    assert.equal(isSemanticallyComplete(COMPLETE_NUMBER, { collectingPhone: true }), true);
    assert.equal(isSemanticallyComplete('my number is 9876543210', { collectingPhone: true }), true);
    assert.equal(isSemanticallyComplete('my number is 9876543210 ext 123', { collectingPhone: true }), true);
  });

  it('no longer force-completes over-long dictations', () => {
    assert.equal(isSemanticallyComplete(LONG_DICTATION, { collectingPhone: true }), false);
  });
});

const FRAME_LEN = 160;
const POLICY = { silenceMs: 5000, minSpeechMs: 300, maxUtteranceMs: 30000, threshold: 0.1, latchDipMs: 200 };

type Mark = 'speech' | 'silence';

function frameHarness(resolver?: (text: string) => boolean): {
  turnTaking: TurnTaking;
  utterances: Utterance[];
  feedOne(mark: Mark): Promise<void>;
} {
  const utterances: Utterance[] = [];
  const vad: Vad = {
    score: async (pcm) => (pcm.every((sample) => sample === 0) ? 0.05 : 0.9),
    reset: () => {},
  };
  const turnTaking = new TurnTaking({
    vad,
    policy: POLICY,
    observer: {
      onUtterance: (utterance) => {
        utterances.push(utterance);
      },
    },
  });
  if (resolver) turnTaking.observeDialogueState({ collecting: true, collectingPhone: true, phoneComplete: resolver });
  else turnTaking.observeDialogueState({ collecting: true, collectingPhone: true });
  return {
    turnTaking,
    utterances,
    feedOne: async (mark: Mark) => {
      const byte = mark === 'speech' ? 0x11 : 0xff;
      await turnTaking.receiveAudio(Buffer.alloc(FRAME_LEN, byte));
    },
  };
}

describe('turn-taking phone boundary (ticket 14)', () => {
  it('never splits the long dictation mid-number; a complete number endpoints', async () => {
    const h = frameHarness();
    for (let i = 0; i < 15; i += 1) await h.feedOne('speech');
    h.turnTaking.observePartial(LONG_DICTATION);
    for (let i = 0; i < 40; i += 1) await h.feedOne('silence');
    assert.equal(h.utterances.length, 0, '800 ms of silence never endpoints mid-number');
    for (let i = 0; i < 10; i += 1) await h.feedOne('speech');
    h.turnTaking.observePartial('+91 98765 43210 98765');
    for (let i = 0; i < 40; i += 1) await h.feedOne('silence');
    assert.equal(h.utterances.length, 0, 'regrouped repeats still hold');
    for (let i = 0; i < 10; i += 1) await h.feedOne('speech');
    h.turnTaking.observePartial(COMPLETE_NUMBER);
    let emittedAt = 0;
    for (let i = 1; i <= 100; i += 1) {
      await h.feedOne('silence');
      if (h.utterances.length > 0) {
        emittedAt = i;
        break;
      }
    }
    assert.equal(emittedAt, 30, 'the completed number endpoints at the 600 ms dialogue floor');
    assert.equal(h.utterances.length, 1);
  });

  it('consults completeness synchronously and at most once per partial', async () => {
    let calls = 0;
    const seen: unknown[] = [];
    const stub = (text: string): boolean => {
      calls += 1;
      const verdict = text === COMPLETE_NUMBER;
      seen.push(verdict);
      return verdict;
    };
    const h = frameHarness(stub);
    for (let i = 0; i < 15; i += 1) await h.feedOne('speech');
    h.turnTaking.observePartial(LONG_DICTATION);
    for (let i = 0; i < 40; i += 1) await h.feedOne('silence');
    assert.equal(h.utterances.length, 0, 'incomplete verdict holds the boundary');
    assert.equal(calls, 1, 'forty silence frames consult the cached verdict once');
    assert.ok(seen.every((verdict) => typeof verdict === 'boolean'), 'the boundary never awaits a verdict');
    h.turnTaking.observePartial(COMPLETE_NUMBER);
    await h.feedOne('silence');
    assert.equal(calls, 2, 'a changed partial re-asks exactly once');
    assert.equal(h.utterances.length, 1, 'the completed number endpoints');
  });
});

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

class FakePhoneStt implements RealtimeStt {
  readonly partials = true;
  finalizeCalls = 0;
  private partialHandler: ((partial: PartialTranscript) => void) | null = null;
  private readonly finals: Transcription[];

  constructor(finals: Transcription[]) {
    this.finals = finals;
  }

  pushAudio(): void {}
  speechStart(): void {}
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

describe('live phone collection (ticket 14)', () => {
  it('holds the long dictation past the floor while collecting the phone', async () => {
    const stt = new FakePhoneStt([
      { text: 'book Wednesday morning', noSpeech: false },
      { text: 'John Smith', noSpeech: false },
      { text: COMPLETE_NUMBER, noSpeech: false },
    ]);
    const { tts, texts } = stubTts();
    const live = new LiveCallSession({
      identity: { callSid: 'CAt14long', streamSid: 'MZt14long' },
      sendAudio: () => {},
      vad: byteVad,
      policy: { silenceMs: 5000, minSpeechMs: 300, maxUtteranceMs: 30000, threshold: 0.5, latchDipMs: 200 },
      transcriber: { transcribe: async () => ({ text: 'rest', noSpeech: false }) },
      realtime: stt,
      tts,
      guide: GUIDE,
      availability: AVAILABILITY,
      assistant,
      calls: new CallStore(),
    });

    for (let i = 0; i < 15; i += 1) await live.receiveAudio(SPEECH_FRAME);
    stt.partial('book Wednesday morning');
    for (let i = 0; i < 15; i += 1) await live.receiveAudio(SILENCE_FRAME);
    await live.flush();
    await waitFor(() => live.currentPhase === 'LISTENING', 'the name question');
    assert.equal(live.state.phase, 'collecting-patient');

    for (let i = 0; i < 15; i += 1) await live.receiveAudio(SPEECH_FRAME);
    stt.partial('John Smith');
    for (let i = 0; i < 30; i += 1) await live.receiveAudio(SILENCE_FRAME);
    await live.flush();
    await waitFor(() => live.currentPhase === 'LISTENING', 'the phone question');
    assert.ok(texts.some((text) => /mobile number/i.test(text)));

    for (let i = 0; i < 15; i += 1) await live.receiveAudio(SPEECH_FRAME);
    stt.partial(LONG_DICTATION);
    for (let i = 0; i < 39; i += 1) await live.receiveAudio(SILENCE_FRAME);
    assert.equal(stt.finalizeCalls, 2, '780 ms of silence never endpoints mid-number');
    stt.partial(COMPLETE_NUMBER);
    await live.receiveAudio(SILENCE_FRAME);
    await live.flush();
    assert.equal(stt.finalizeCalls, 3, 'the completed number endpoints');
    assert.equal(live.state.patient.phone, COMPLETE_NUMBER);
    live.close('test');
  });
});
