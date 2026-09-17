import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TurnTaking } from '../src/turnTaking.ts';
import type { StallEvent, Utterance, Vad } from '../src/endpoint.ts';

const FRAME_BYTES = 160; // 20 ms of 8 kHz mulaw, the Twilio media frame size.
const POLICY = { silenceMs: 5000, minSpeechMs: 300, maxUtteranceMs: 30000, threshold: 0.1, latchDipMs: 200 };
const GRACE_MS = 1200;

type Mark = 'speech' | 'silence';

interface Harness {
  turnTaking: TurnTaking;
  utterances: Utterance[];
  stalls: StallEvent[];
  speechStarts: number;
  feed(pattern: Mark[]): Promise<void>;
  /** Feed one frame, resolving after it is fully processed. */
  feedOne(mark: Mark): Promise<void>;
}

/** The frame bytes are the script: 0x11 is audible speech, 0xFF is mu-law silence. */
function harness(): Harness {
  const utterances: Utterance[] = [];
  const stalls: StallEvent[] = [];
  let speechStarts = 0;
  const vad: Vad = {
    score: async (pcm) => (pcm.every((sample) => sample === 0) ? 0.05 : 0.9),
    reset: () => {},
  };
  const turnTaking = new TurnTaking({
    vad,
    policy: POLICY,
    detection: 'sarvam',
    stallGraceMs: GRACE_MS,
    observer: {
      onUtterance: (utterance) => {
        utterances.push(utterance);
      },
      onStall: (event) => {
        stalls.push(event);
      },
      onSpeechStart: () => {
        speechStarts += 1;
      },
    },
  });
  const h: Harness = {
    turnTaking,
    utterances,
    stalls,
    get speechStarts() {
      return speechStarts;
    },
    feedOne: async (mark) => {
      const byte = mark === 'speech' ? 0x11 : 0xff;
      await turnTaking.receiveAudio(Buffer.alloc(FRAME_BYTES, byte));
    },
    feed: async (pattern) => {
      for (const mark of pattern) await h.feedOne(mark);
    },
  };
  return h;
}

/** Feed `mark` one frame at a time until a new utterance lands; returns its frame count. */
async function framesToEmit(h: Harness, mark: Mark, max: number): Promise<number> {
  const before = h.utterances.length;
  for (let i = 1; i <= max; i += 1) {
    await h.feedOne(mark);
    if (h.utterances.length > before) return i;
  }
  return 0;
}

describe('provider stall guard', () => {
  it('takes the boundary after the stall grace and reports the evidence', async () => {
    const h = harness();
    h.turnTaking.providerSpeechStart();
    await h.feed(Array<Mark>(15).fill('speech'));
    const emittedAt = await framesToEmit(h, 'silence', 100);
    assert.equal(emittedAt, GRACE_MS / 20, '1200 ms of local trailing silence takes the boundary');
    assert.equal(h.utterances.length, 1);
    assert.equal(h.utterances[0]!.stalled, true, 'the Turn is marked as a stall');
    assert.equal(h.utterances[0]!.durationMs, 300, 'the trailing silence is not part of the speech');
    assert.equal(h.speechStarts, 1);
    assert.deepEqual(h.stalls, [{ trailingSilenceMs: 1200, speechMs: 300, graceMs: GRACE_MS }]);
  });

  it('lets the provider end inside the grace emit normally, with no stall evidence', async () => {
    const h = harness();
    h.turnTaking.providerSpeechStart();
    await h.feed(Array<Mark>(15).fill('speech'));
    await h.feed(Array<Mark>(30).fill('silence'));
    h.turnTaking.providerSpeechEnd();
    assert.equal(h.utterances.length, 1);
    assert.notEqual(h.utterances[0]!.stalled, true);
    assert.equal(h.utterances[0]!.durationMs, 900, 'the provider-owned capture keeps its trailing silence');
    assert.deepEqual(h.stalls, []);
    await h.feed(Array<Mark>(100).fill('silence'));
    assert.equal(h.utterances.length, 1, 'the stall watch is disarmed by the provider boundary');
  });

  it('takes the boundary when the provider never announces the utterance', async () => {
    const h = harness();
    await h.feed(Array<Mark>(15).fill('speech'));
    const emittedAt = await framesToEmit(h, 'silence', 100);
    assert.equal(emittedAt, GRACE_MS / 20, 'local speech presence alone arms the guard');
    assert.equal(h.utterances[0]!.stalled, true);
    assert.equal(h.utterances[0]!.durationMs, 300);
    assert.deepEqual(h.stalls, [{ trailingSilenceMs: 1200, speechMs: 300, graceMs: GRACE_MS }]);
  });

  it('guards a provider utterance adopted from a Barge-in candidate', async () => {
    const h = harness();
    h.turnTaking.acceptBargeIn({ audio: new Int16Array(2400).fill(1000), durationMs: 300, corroborated: true });
    const emittedAt = await framesToEmit(h, 'silence', 100);
    assert.equal(emittedAt, GRACE_MS / 20);
    assert.equal(h.utterances[0]!.stalled, true);
    assert.equal(h.utterances[0]!.durationMs, 300);
    assert.equal(h.stalls[0]!.speechMs, 300);
  });

  it('never takes the boundary without local speech presence', async () => {
    const h = harness();
    h.turnTaking.providerSpeechStart();
    await h.feed(Array<Mark>(100).fill('silence'));
    assert.equal(h.utterances.length, 0, 'silence alone is not a stalled Turn');
    assert.deepEqual(h.stalls, []);
  });

  it('ignores a blip shorter than the minimum speech floor', async () => {
    const h = harness();
    await h.feed(Array<Mark>(1).fill('speech'));
    await h.feed(Array<Mark>(100).fill('silence'));
    assert.equal(h.utterances.length, 0, 'a blip is not a Turn');
    assert.deepEqual(h.stalls, []);
    assert.equal(h.speechStarts, 0, 'a blip never announces Caller speech');
  });

  it('restarts the stall clock when speech resumes', async () => {
    const h = harness();
    h.turnTaking.providerSpeechStart();
    await h.feed(Array<Mark>(15).fill('speech'));
    await h.feed(Array<Mark>(40).fill('silence'));
    await h.feed(Array<Mark>(5).fill('speech'));
    const emittedAt = await framesToEmit(h, 'silence', 100);
    assert.equal(emittedAt, GRACE_MS / 20, 'the grace runs from the last local speech');
    assert.equal(h.utterances[0]!.stalled, true);
    assert.equal(h.utterances[0]!.durationMs, 1200, 'the internal pause stays in the captured audio');
  });

  it('runs the local detector on the next Turn after the session switches mode', async () => {
    const h = harness();
    h.turnTaking.providerSpeechStart();
    await h.feed(Array<Mark>(15).fill('speech'));
    await framesToEmit(h, 'silence', 100);
    h.turnTaking.setDetection('hybrid');
    h.turnTaking.startListening();
    await h.feed(Array<Mark>(15).fill('speech'));
    const emittedAt = await framesToEmit(h, 'silence', 100);
    assert.equal(emittedAt, 15, 'the adaptive floor owns the boundary after the switch');
    assert.equal(h.utterances.length, 2);
    assert.notEqual(h.utterances[1]!.stalled, true, 'detector-owned Turns are not stalls');
  });
});
