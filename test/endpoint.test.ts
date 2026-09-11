import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeMulaw } from '../src/mulaw.ts';
import { Endpointer, type Utterance, type Vad } from '../src/endpoint.ts';
import { SileroVad } from '../src/sileroVad.ts';
import { attachStreamSocket } from '../src/stream.ts';
import {
  FakeSocket,
  twilioMedia,
  twilioStart,
  twilioStop,
} from './fakeStream.ts';

const FRAME_BYTES = 160; // 20 ms of 8 kHz mulaw, the Twilio media frame size.
const POLICY = { silenceMs: 700, minSpeechMs: 300, maxUtteranceMs: 30000, threshold: 0.5 };

describe('mulaw decode', () => {
  it('decodes known vectors', () => {
    assert.equal(decodeMulaw(Buffer.from([0xff]))[0], 0);
    assert.equal(decodeMulaw(Buffer.from([0x00]))[0], -32124);
    assert.equal(decodeMulaw(Buffer.from([0x80]))[0], 32124);
  });

  it('decodes silence to near-zero', () => {
    const pcm = decodeMulaw(Buffer.alloc(FRAME_BYTES, 0xff));
    assert.equal(pcm.length, FRAME_BYTES);
    assert.ok(pcm.every((s) => s === 0));
  });
});

/** Scripted VAD: each score() consumes the next pattern entry. */
function scriptVad(pattern: ('speech' | 'silence')[]): Vad & { calls: number } {
  let calls = 0;
  return {
    calls: 0,
    score: async () => {
      calls += 1;
      return pattern[Math.min(calls - 1, pattern.length - 1)] === 'speech' ? 0.9 : 0.05;
    },
    reset: () => {},
  };
}

const speech = (frames: number): ('speech' | 'silence')[] => Array(frames).fill('speech');
const silence = (frames: number): ('speech' | 'silence')[] => Array(frames).fill('silence');

interface Harness {
  socket: FakeSocket;
  utterances: Utterance[];
  endpointer: Endpointer;
  /** Feed scripted frames through the socket; resolves when all audio is processed. */
  feed(pattern: ('speech' | 'silence')[]): Promise<void>;
}

function harness(vad: Vad): Harness {
  const socket = new FakeSocket();
  const utterances: Utterance[] = [];
  const endpointer = new Endpointer(vad, POLICY, {
    onUtterance: (u) => utterances.push(u),
  });
  let tail: Promise<unknown> = Promise.resolve();
  attachStreamSocket(socket, {
    onAudio: (_identity, audio) => {
      tail = tail.then(() => endpointer.receiveAudio(audio));
    },
    onClose: () => {},
  });
  socket.peerMessage(twilioStart({ callSid: 'CA8', streamSid: 'MZ8' }));
  return {
    socket,
    utterances,
    endpointer,
    feed: async (pattern) => {
      for (const _mark of pattern) {
        socket.peerMessage(twilioMedia(Buffer.alloc(FRAME_BYTES, 0xff).toString('base64')));
      }
      await tail;
    },
  };
}

describe('endpointer', () => {
  it('emits one utterance after trailing silence', async () => {
    const h = harness(scriptVad([...speech(50), ...silence(50)]));
    await h.feed([...speech(50), ...silence(50)]);
    assert.equal(h.utterances.length, 1);
    assert.ok(h.utterances[0]!.durationMs >= 900 && h.utterances[0]!.durationMs <= 1100);
    assert.equal(h.utterances[0]!.audio.length, h.utterances[0]!.durationMs * 8);
  });

  it('does not split on a brief mid-sentence pause', async () => {
    const h = harness(scriptVad([...speech(30), ...silence(15), ...speech(30), ...silence(50)]));
    await h.feed([...speech(30), ...silence(15), ...speech(30), ...silence(50)]);
    assert.equal(h.utterances.length, 1);
  });

  it('ignores sub-minimum noises', async () => {
    const h = harness(scriptVad([...speech(10), ...silence(100)]));
    await h.feed([...speech(10), ...silence(100)]);
    assert.equal(h.utterances.length, 0);
  });

  it('force-ends an overlong utterance at the cap', async () => {
    const frames = 1750; // 35 s of continuous speech.
    const h = harness(scriptVad(speech(frames)));
    await h.feed(speech(frames));
    assert.ok(h.utterances.length >= 1);
    assert.ok(h.utterances[0]!.durationMs >= 29900 && h.utterances[0]!.durationMs <= 30100);
  });

  it('keeps listening after an utterance ends', async () => {
    const pattern = [...speech(50), ...silence(50), ...speech(50), ...silence(50)];
    const h = harness(scriptVad(pattern));
    await h.feed(pattern);
    assert.equal(h.utterances.length, 2);
  });

  it('discards audio while suspended and restarts clean on resume', async () => {
    // Suspended frames are never scored, so the script covers only post-resume audio.
    const h = harness(scriptVad([...speech(50), ...silence(50)]));
    h.endpointer.suspend();
    await h.feed(speech(200));
    assert.equal(h.utterances.length, 0);
    h.endpointer.resume();
    await h.feed([...speech(50), ...silence(50)]);
    assert.equal(h.utterances.length, 1);
    assert.ok(h.utterances[0]!.durationMs <= 1100);
  });

  it('drops a partial utterance when the session ends', async () => {
    const h = harness(scriptVad(speech(50)));
    await h.feed(speech(50));
    h.endpointer.endSession();
    assert.equal(h.utterances.length, 0);
  });

  it('closes the session without emitting on stop', async () => {
    const h = harness(scriptVad([...speech(50), ...silence(50)]));
    await h.feed([...speech(50), ...silence(50)]);
    h.socket.peerMessage(twilioStop());
    assert.equal(h.utterances.length, 1);
  });
});

describe('silero backend', () => {
  it('loads the model and scores silence low', async () => {
    const vad = await SileroVad.load('./models/silero_vad.onnx');
    const prob = await vad.score(new Int16Array(256));
    assert.ok(prob >= 0 && prob <= 1);
    assert.ok(prob < 0.5, `expected silence to score low, got ${prob}`);
    vad.reset();
  });
});
