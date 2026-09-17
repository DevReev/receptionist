import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TurnTaking } from '../src/turnTaking.ts';
import type { BargeInEvent, Utterance, Vad } from '../src/endpoint.ts';
import { attachStreamSocket } from '../src/stream.ts';
import { FakeSocket, twilioMedia, twilioStart } from './fakeStream.ts';

const FRAME_BYTES = 160; // 20 ms of 8 kHz mulaw, the Twilio media frame size.
const POLICY = { silenceMs: 700, minSpeechMs: 300, maxUtteranceMs: 30000, threshold: 0.1, latchDipMs: 200 };

type Frame = 'speech' | 'silence';

/** Scripted VAD: each score() consumes the next pattern entry. */
function scriptVad(pattern: Frame[]): Vad {
  let calls = 0;
  return {
    score: async () => {
      calls += 1;
      return pattern[Math.min(calls - 1, pattern.length - 1)] === 'speech' ? 0.9 : 0.05;
    },
    reset: () => {},
  };
}

const speech = (frames: number): Frame[] => Array(frames).fill('speech');
const silence = (frames: number): Frame[] => Array(frames).fill('silence');

interface Harness {
  socket: FakeSocket;
  utterances: Utterance[];
  bargeIns: BargeInEvent[];
  turnTaking: TurnTaking;
  feed(pattern: Frame[]): Promise<void>;
}

function harness(vad: Vad, options?: { bargeInMs?: number }): Harness {
  const socket = new FakeSocket();
  const utterances: Utterance[] = [];
  const bargeIns: BargeInEvent[] = [];
  const turnTaking = new TurnTaking({
    vad,
    policy: POLICY,
    bargeInMs: options?.bargeInMs,
    detection: 'hybrid',
    observer: {
      onUtterance: (u) => utterances.push(u),
      onBargeIn: (e) => bargeIns.push(e),
    },
  });
  let tail: Promise<unknown> = Promise.resolve();
  attachStreamSocket(socket, {
    onAudio: (_identity, audio) => {
      tail = tail.then(() => turnTaking.receiveAudio(audio));
    },
    onClose: () => {},
  });
  socket.peerMessage(twilioStart({ callSid: 'CA9', streamSid: 'MZ9' }));
  let frame = 0;
  return {
    socket,
    utterances,
    bargeIns,
    turnTaking,
    feed: async (pattern) => {
      for (const kind of pattern) {
        const byte = kind === 'speech' ? (frame % 254) + 1 : 0xff;
        frame += 1;
        socket.peerMessage(twilioMedia(Buffer.alloc(FRAME_BYTES, byte).toString('base64')));
      }
      await tail;
    },
  };
}

describe('turn taking barge-in candidates', () => {
  it('fires onBargeIn after sustained speech while watching', async () => {
    const h = harness(scriptVad(speech(30)));
    h.turnTaking.startSpeaking({ watchForBargeIn: true });
    await h.feed(speech(30));
    assert.equal(h.bargeIns.length, 1);
    const event = h.bargeIns[0]!;
    assert.ok(event.durationMs >= 200);
    assert.equal(event.audio.length, event.durationMs * 8);
    assert.equal(h.utterances.length, 0);
  });

  it('does not fire on a short burst below the barge-in threshold', async () => {
    const h = harness(scriptVad([...speech(5), ...silence(50)]));
    h.turnTaking.startSpeaking({ watchForBargeIn: true });
    await h.feed([...speech(5), ...silence(50)]);
    assert.equal(h.bargeIns.length, 0);
  });

  it('never fires while fully muted', async () => {
    const h = harness(scriptVad(speech(30)));
    h.turnTaking.startSpeaking();
    await h.feed(speech(30));
    assert.equal(h.bargeIns.length, 0);
    assert.equal(h.utterances.length, 0);
  });

  it('fires exactly once and drops audio until the candidate is accepted', async () => {
    const h = harness(scriptVad(speech(100)));
    h.turnTaking.startSpeaking({ watchForBargeIn: true });
    await h.feed(speech(100));
    assert.equal(h.bargeIns.length, 1);
    assert.equal(h.utterances.length, 0);
  });

  it('honors a custom barge-in threshold', async () => {
    const h = harness(scriptVad(speech(20)), { bargeInMs: 100 });
    h.turnTaking.startSpeaking({ watchForBargeIn: true });
    await h.feed(speech(20));
    assert.equal(h.bargeIns.length, 1);
    assert.equal(h.bargeIns[0]!.durationMs, 100);
    assert.equal(h.bargeIns[0]!.audio.length, 800);
  });

  it('retains pre-roll so the first word is not clipped', async () => {
    const h = harness(scriptVad([...silence(20), ...speech(15)]));
    h.turnTaking.startSpeaking({ watchForBargeIn: true });
    await h.feed([...silence(20), ...speech(15)]);
    assert.equal(h.bargeIns.length, 1);
    assert.equal(h.bargeIns[0]!.durationMs, 500);
  });

  it('accepts the barge-in audio as the start of the next utterance', async () => {
    const h = harness(scriptVad([...speech(30), ...silence(80)]));
    h.turnTaking.startSpeaking({ watchForBargeIn: true });
    await h.feed(speech(15));
    assert.equal(h.bargeIns.length, 1);
    const event = h.bargeIns[0]!;

    h.turnTaking.acceptBargeIn(event);
    await h.feed([...speech(20), ...silence(50)]);

    assert.equal(h.utterances.length, 1);
    const utterance = h.utterances[0]!;
    assert.ok(utterance.durationMs >= event.durationMs + 400);
    assert.equal(utterance.audio.length, utterance.durationMs * 8);
    assert.deepEqual(utterance.audio.subarray(0, event.audio.length), event.audio);
  });

  it('reports listening while a Turn can still end', () => {
    const h = harness(scriptVad(speech(1)));
    assert.equal(h.turnTaking.isListening, true);

    h.turnTaking.startSpeaking();
    assert.equal(h.turnTaking.isListening, false);

    h.turnTaking.startSpeaking({ watchForBargeIn: true });
    assert.equal(h.turnTaking.isListening, false);

    h.turnTaking.startListening();
    assert.equal(h.turnTaking.isListening, true);
  });

  it('emits normally after resuming listening', async () => {
    const h = harness(scriptVad([...speech(50), ...silence(50)]));
    h.turnTaking.startSpeaking({ watchForBargeIn: true });
    h.turnTaking.startListening();
    await h.feed([...speech(50), ...silence(50)]);
    assert.equal(h.utterances.length, 1);
    assert.equal(h.bargeIns.length, 0);
  });
});
