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

  it('releases a stale partial at the staleness budget, not the emergency cap', async () => {
    const h = harness();
    await h.feed(Array<Mark>(15).fill('speech'));
    h.turnTaking.observePartial('and');
    // A partial that never updates is provider lag, not a mid-thought pause:
    // the boundary emits at the 1300 ms staleness budget (66 frames), not the
    // 1500 ms emergency cap.
    const emittedAt = await framesToEmit(h, 'silence', 200);
    assert.equal(emittedAt, 66, 'stale evidence releases before the cap');
    assert.equal(h.utterances.length, 1);
  });

  it('holds to the emergency cap while fresh partials keep arriving', async () => {
    const h = harness();
    await h.feed(Array<Mark>(15).fill('speech'));
    h.turnTaking.observePartial('and');
    // Refresh the evidence the way a live provider would: the boundary holds.
    for (let i = 0; i < 7; i += 1) {
      await h.feed(Array<Mark>(10).fill('silence'));
      h.turnTaking.observePartial('and');
    }
    assert.equal(h.utterances.length, 0, 'fresh continuation evidence still holds');
    const emittedAt = await framesToEmit(h, 'silence', 200);
    assert.equal(emittedAt, 5, 'the cap still ends a Turn the evidence holds open');
    assert.equal(h.utterances.length, 1);
  });

  it('holds mid-list phrases past the pause while completed sentences endpoint', async () => {
    const held = [
      'can you tell me',
      "I'd like to",
      'I want',
      'I need',
      'I was wondering',
      'give me',
      'I am not',
      'better than',
      'the other',
    ];
    for (const partial of held) {
      const h = harness();
      await h.feed(Array<Mark>(15).fill('speech'));
      h.turnTaking.observePartial(partial);
      // 400 ms, past the 300 ms floor: a mid-thought pause must not cut.
      await h.feed(Array<Mark>(20).fill('silence'));
      assert.equal(h.utterances.length, 0, `mid-list holds: ${partial}`);
    }
    const complete = [
      'what are your hours',
      'I would like to book an appointment',
      'my name is John Smith',
      'that is all.',
      'No.',
    ];
    for (const partial of complete) {
      const h = harness();
      await h.feed(Array<Mark>(15).fill('speech'));
      h.turnTaking.observePartial(partial);
      const emittedAt = await framesToEmit(h, 'silence', 100);
      assert.equal(emittedAt, 15, `completed sentence endpoints at the floor: ${partial}`);
    }
  });

  it('holds grouped digits past the pause while collecting the Patient phone', async () => {
    const h = harness();
    await h.feed(Array<Mark>(15).fill('speech'));
    h.turnTaking.observeDialogueState(true, true);
    h.turnTaking.observePartial('98765');
    // 800 ms of silence: past the 600 ms dialogue floor, held by the open grouping.
    await h.feed(Array<Mark>(40).fill('silence'));
    assert.equal(h.utterances.length, 0, 'grouped digits do not endpoint mid-number');
    h.turnTaking.observePartial('9876543210');
    const emittedAt = await framesToEmit(h, 'silence', 100);
    assert.equal(emittedAt, 1, 'the completed number endpoints at once');
    assert.equal(h.utterances.length, 1);
  });

  it('endpoints a dictated name at the dialogue floor without the phone flag', async () => {
    const h = harness();
    await h.feed(Array<Mark>(15).fill('speech'));
    // Name collection: the longer floor only, no grouping hold.
    h.turnTaking.observeDialogueState(true);
    h.turnTaking.observePartial('John Smith');
    const emittedAt = await framesToEmit(h, 'silence', 100);
    assert.equal(emittedAt, 30, 'name collection keeps the 600 ms floor');
    assert.equal(h.utterances.length, 1);
  });

  it('holds a partial ending in an abbreviation past the floor', async () => {
    const h = harness();
    await h.feed(Array<Mark>(15).fill('speech'));
    h.turnTaking.observePartial('I need to see Dr.');
    await h.feed(Array<Mark>(20).fill('silence'));
    assert.equal(h.utterances.length, 0, 'Dr. is not sentence-terminal');
    await h.feed(Array<Mark>(10).fill('speech'));
    h.turnTaking.observePartial('I need to see Dr. Smith');
    const emittedAt = await framesToEmit(h, 'silence', 100);
    assert.equal(emittedAt, 15, 'the finished thought ends at the adaptive floor');
    assert.equal(h.utterances.length, 1, 'both speech runs belong to one Turn');
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

  it('holds a complete sentence with list cues past the floor and resumes as one Turn', async () => {
    const h = harness();
    await h.feed(Array<Mark>(15).fill('speech'));
    h.turnTaking.observePartial('I also wanted to ask about the fee');
    // A 400 ms pause, past the 300 ms floor: the list cue ("also") holds the
    // boundary for one extra bounded beat instead of endpointing mid-list.
    await h.feed(Array<Mark>(20).fill('silence'));
    assert.equal(h.utterances.length, 0, 'a mid-list sentence pause does not cut');
    await h.feed(Array<Mark>(10).fill('speech'));
    h.turnTaking.observePartial('I also wanted to ask about the fee and whether you have parking');
    const emittedAt = await framesToEmit(h, 'silence', 100);
    // The resumed finish still carries "also", so it endpoints at the bounded
    // window (floor 300 ms + 800 ms): this is the measured one-beat cost of a
    // finished list-cued sentence.
    assert.equal(emittedAt, 55, 'the finished list-cued sentence costs one bounded beat');
    assert.equal(h.utterances.length, 1, 'both speech runs belong to one Turn');
  });

  it('endpoints a list-cued sentence when the continuation never comes', async () => {
    const h = harness();
    await h.feed(Array<Mark>(15).fill('speech'));
    h.turnTaking.observePartial('I also wanted to ask about the fee');
    // Floor 300 ms + the 800 ms list window = 1100 ms = 55 frames: the hold
    // is bounded, so a finished list costs one short beat, never an open hold.
    const emittedAt = await framesToEmit(h, 'silence', 200);
    assert.equal(emittedAt, 55, 'the list hold releases at the bounded window');
    assert.equal(h.utterances.length, 1);
  });

  it('endpoints a complete sentence without list cues at the floor', async () => {
    const h = harness();
    await h.feed(Array<Mark>(15).fill('speech'));
    h.turnTaking.observePartial('I wanted to ask about the fee');
    const emittedAt = await framesToEmit(h, 'silence', 100);
    assert.equal(emittedAt, 15, 'no list cue, no extra hold');
    assert.equal(h.utterances.length, 1);
  });
});
