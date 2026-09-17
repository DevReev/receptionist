import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TurnTaking } from '../src/turnTaking.ts';
import type { Utterance, Vad } from '../src/endpoint.ts';

const FRAME_BYTES = 160; // 20 ms of 8 kHz mulaw, the Twilio media frame size.
/**
 * The fixed silence knob is deliberately far away: hybrid boundaries must come
 * from the adaptive pause, not from the retired local constant.
 */
const POLICY = { silenceMs: 5000, minSpeechMs: 300, maxUtteranceMs: 30000, threshold: 0.1, latchDipMs: 200 };

type Mark = 'speech' | 'silence';

interface Harness {
  turnTaking: TurnTaking;
  utterances: Utterance[];
  feed(pattern: Mark[]): Promise<void>;
  /** Feed one frame, resolving after it is fully processed. */
  feedOne(mark: Mark): Promise<void>;
}

/** The frame bytes are the script: 0x11 is audible speech, 0xFF is mu-law silence. */
function harness(): Harness {
  const utterances: Utterance[] = [];
  const vad: Vad = {
    score: async (pcm) => (pcm.every((sample) => sample === 0) ? 0.05 : 0.9),
    reset: () => {},
  };
  const turnTaking = new TurnTaking({
    vad,
    policy: POLICY,
    detection: 'hybrid',
    observer: {
      onUtterance: (utterance) => {
        utterances.push(utterance);
      },
    },
  });
  const feedOne = async (mark: Mark): Promise<void> => {
    const byte = mark === 'speech' ? 0x11 : 0xff;
    await turnTaking.receiveAudio(Buffer.alloc(FRAME_BYTES, byte));
  };
  return {
    turnTaking,
    utterances,
    feedOne,
    feed: async (pattern) => {
      for (const mark of pattern) await feedOne(mark);
    },
  };
}

/** Feed `mark` one frame at a time until the first utterance lands; returns its frame count. */
async function framesToEmit(h: Harness, mark: Mark, max: number): Promise<number> {
  for (let i = 1; i <= max; i += 1) {
    await h.feedOne(mark);
    if (h.utterances.length > 0) return i;
  }
  return 0;
}

describe('hybrid detector boundaries', () => {
  it('ends the Turn after the default 300 ms until pauses are observed', async () => {
    const h = harness();
    await h.feed(Array<Mark>(15).fill('speech'));
    assert.equal(h.utterances.length, 0, 'the utterance is still gathering');
    const emittedAt = await framesToEmit(h, 'silence', 100);
    assert.equal(emittedAt, 15, '300 ms of trailing silence ends the Turn');
  });

  it('tracks the Caller pause rhythm: 1.25 x p90 of the last pauses', async () => {
    const pattern: Mark[] = [
      ...Array<Mark>(15).fill('speech'),
      // Three completed 200 ms pauses inside the utterance.
      ...Array<Mark>(5).fill('speech'),
      ...Array<Mark>(10).fill('silence'),
      ...Array<Mark>(5).fill('speech'),
      ...Array<Mark>(10).fill('silence'),
      ...Array<Mark>(5).fill('speech'),
      ...Array<Mark>(10).fill('silence'),
      ...Array<Mark>(1).fill('speech'),
    ];
    const h = harness();
    await h.feed(pattern);
    assert.equal(h.utterances.length, 0, 'a 200 ms pause never ends this Caller utterance');
    const emittedAt = await framesToEmit(h, 'silence', 100);
    assert.equal(emittedAt, 13, '1.25 x 200 ms = 250 ms of trailing silence ends the Turn');
    assert.equal(h.utterances[0]!.durationMs, 1220);
  });

  it('holds a mid-thought pause open on a continuation cue and emits on the resumed finish', async () => {
    const h = harness();
    await h.feed(Array<Mark>(15).fill('speech'));
    h.turnTaking.observePartial('I would like to book an appointment for');
    // 400 ms pause, past the 300 ms floor, held open by the trailing "for".
    await h.feed(Array<Mark>(20).fill('silence'));
    assert.equal(h.utterances.length, 0, 'a clear continuation cue holds the boundary');
    await h.feed(Array<Mark>(10).fill('speech'));
    h.turnTaking.observePartial('I would like to book an appointment for Monday');
    const emittedAt = await framesToEmit(h, 'silence', 100);
    assert.equal(emittedAt, 15, 'the finished thought ends at the adaptive floor');
    assert.equal(h.utterances.length, 1, 'both speech runs belong to one Turn');
    assert.equal(h.utterances[0]!.durationMs, 900);
  });

  it('emits at the 1.5 s emergency cap whatever the partials say', async () => {
    const h = harness();
    await h.feed(Array<Mark>(15).fill('speech'));
    h.turnTaking.observePartial('and');
    const emittedAt = await framesToEmit(h, 'silence', 200);
    assert.equal(emittedAt, 75, '1500 ms of trailing silence emits regardless');
    assert.equal(h.utterances.length, 1);
  });

  it('raises the floor to 600 ms while collecting the Patient name or phone', async () => {
    const h = harness();
    await h.feed(Array<Mark>(15).fill('speech'));
    h.turnTaking.observeDialogueState(true);
    const emittedAt = await framesToEmit(h, 'silence', 100);
    assert.equal(emittedAt, 30, 'the dialogue floor holds a 300 ms pause open');
    assert.equal(h.utterances.length, 1);
  });

  it('returns to the adaptive floor when field collection ends', async () => {
    const h = harness();
    await h.feed(Array<Mark>(15).fill('speech'));
    h.turnTaking.observeDialogueState(true);
    h.turnTaking.observeDialogueState(false);
    const emittedAt = await framesToEmit(h, 'silence', 100);
    assert.equal(emittedAt, 15);
  });

  it('emits a semantically complete partial at the adaptive floor', async () => {
    const h = harness();
    await h.feed(Array<Mark>(15).fill('speech'));
    h.turnTaking.observePartial('what are your hours');
    const emittedAt = await framesToEmit(h, 'silence', 100);
    assert.equal(emittedAt, 15);
  });
});
