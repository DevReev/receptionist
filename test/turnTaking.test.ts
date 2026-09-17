import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TurnTaking, type UtteranceSpeechStats } from '../src/turnTaking.ts';
import type { Utterance, Vad } from '../src/endpoint.ts';
import { attachStreamSocket } from '../src/stream.ts';
import { FakeSocket, twilioMedia, twilioStart, twilioStop } from './fakeStream.ts';

const FRAME_BYTES = 160; // 20 ms of 8 kHz mulaw, the Twilio media frame size.
const POLICY = { silenceMs: 700, minSpeechMs: 300, maxUtteranceMs: 30000, threshold: 0.1, latchDipMs: 200 };

/** Scripted VAD: each score() consumes the next pattern entry. */
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

function scoredVad(scores: number[]): Vad {
  let calls = 0;
  return {
    score: async () => scores[Math.min(calls++, scores.length - 1)]!,
    reset: () => {},
  };
}

const speech = (frames: number): ('speech' | 'silence')[] => Array(frames).fill('speech');
const silence = (frames: number): ('speech' | 'silence')[] => Array(frames).fill('silence');

interface Harness {
  socket: FakeSocket;
  utterances: Utterance[];
  stats: UtteranceSpeechStats[];
  speechStarts: number;
  turnTaking: TurnTaking;
  /** Feed scripted frames through the socket; resolves when all audio is processed. */
  feed(pattern: ('speech' | 'silence')[]): Promise<void>;
}

function harness(vad: Vad): Harness {
  const socket = new FakeSocket();
  const utterances: Utterance[] = [];
  const stats: UtteranceSpeechStats[] = [];
  const state = { speechStarts: 0 };
  const turnTaking = new TurnTaking({
    vad,
    policy: POLICY,
    detection: 'hybrid',
    observer: {
      onUtterance: (utterance, utteranceStats) => {
        utterances.push(utterance);
        stats.push(utteranceStats);
      },
      onSpeechStart: () => {
        state.speechStarts += 1;
      },
    },
  });
  let tail: Promise<unknown> = Promise.resolve();
  attachStreamSocket(socket, {
    onAudio: (_identity, audio) => {
      tail = tail.then(() => turnTaking.receiveAudio(audio));
    },
    onClose: () => {},
  });
  socket.peerMessage(twilioStart({ callSid: 'CA8', streamSid: 'MZ8' }));
  return {
    socket,
    utterances,
    stats,
    get speechStarts() {
      return state.speechStarts;
    },
    turnTaking,
    feed: async (pattern) => {
      for (const _mark of pattern) {
        socket.peerMessage(twilioMedia(Buffer.alloc(FRAME_BYTES, 0xff).toString('base64')));
      }
      await tail;
    },
  };
}

describe('turn taking', () => {
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

  it('latches through VAD flicker shorter than the dip budget', async () => {
    // Real VAD output flickers at speech boundaries: single silence frames
    // inside speech must not reset the latch (strict consecutiveness never
    // latched on live audio — max observed run 160 ms vs 300 ms latch).
    const flicker: ('speech' | 'silence')[] = [];
    for (let i = 0; i < 10; i++) flicker.push(...speech(4), ...silence(1));
    const pattern = [...flicker, ...silence(50)];
    const h = harness(scriptVad(pattern));
    await h.feed(pattern);
    assert.equal(h.utterances.length, 1);
  });

  it('latches low-confidence phone speech with an isolated high score', async () => {
    // Live Twilio audio crossed the threshold but never latched, so the
    // Receptionist heard continuous media without producing an utterance.
    // Sub-threshold frames inside the phrase still belong in its candidate
    // duration and audio; only a dip exceeding the tolerance should reset it.
    const phoneSpeech = Array.from({ length: 20 }, (_, i) => [0.35, 0.18, 0.12, 0.769][i % 4]!);
    const scores = [...phoneSpeech, ...Array<number>(50).fill(0.05)];
    const pattern = [...speech(phoneSpeech.length), ...silence(50)];
    const h = harness(scoredVad(scores));
    await h.feed(pattern);
    assert.equal(h.utterances.length, 1);
    assert.equal(h.utterances[0]!.durationMs, 400);
  });

  it('latches sustained phone speech that scores just above background', async () => {
    const phoneSpeech = [0.409, ...Array<number>(12).fill(0.12), 0.379, ...Array<number>(12).fill(0.11), 0.574];
    const scores = [...phoneSpeech, ...Array<number>(50).fill(0.05)];
    const pattern = [...speech(phoneSpeech.length), ...silence(50)];
    const h = harness(scoredVad(scores));
    await h.feed(pattern);
    assert.equal(h.utterances.length, 1);
  });

  it('includes pre-speech audio so the first word is not clipped', async () => {
    const pattern = [...silence(20), ...speech(20), ...silence(50)];
    const h = harness(scriptVad(pattern));
    await h.feed(pattern);
    assert.equal(h.utterances.length, 1);
    assert.equal(h.utterances[0]!.durationMs, 700);
  });

  it('resets the latch when the dip exceeds the budget', async () => {
    const pattern = [...speech(10), ...silence(15), ...speech(10), ...silence(50)];
    const h = harness(scriptVad(pattern));
    await h.feed(pattern);
    assert.equal(h.utterances.length, 0);
  });

  it('force-ends an overlong utterance at the cap', async () => {
    const frames = 1750; // 35 s of continuous speech.
    const h = harness(scriptVad(speech(frames)));
    await h.feed(speech(frames));
    assert.ok(h.utterances.length >= 1);
    assert.ok(h.utterances[0]!.durationMs >= 29900 && h.utterances[0]!.durationMs <= 30100);
  });

  it('holds the floor after an utterance until listening resumes', async () => {
    const pattern = [...speech(50), ...silence(50), ...speech(50), ...silence(50)];
    const h = harness(scriptVad(pattern));
    await h.feed([...speech(50), ...silence(50)]);
    assert.equal(h.utterances.length, 1);
    await h.feed([...speech(50), ...silence(50)]);
    assert.equal(h.utterances.length, 1);
    h.turnTaking.startListening();
    await h.feed([...speech(50), ...silence(50)]);
    assert.equal(h.utterances.length, 2);
  });

  it('discards audio while the Receptionist holds the floor and restarts clean', async () => {
    // Muted frames are never scored, so the script covers only post-listening audio.
    const h = harness(scriptVad([...speech(50), ...silence(50)]));
    h.turnTaking.startSpeaking();
    await h.feed(speech(200));
    assert.equal(h.utterances.length, 0);
    h.turnTaking.startListening();
    await h.feed([...speech(50), ...silence(50)]);
    assert.equal(h.utterances.length, 1);
    assert.ok(h.utterances[0]!.durationMs <= 1100);
  });

  it('drops a partial utterance when the session ends', async () => {
    const h = harness(scriptVad(speech(50)));
    await h.feed(speech(50));
    h.turnTaking.close();
    assert.equal(h.utterances.length, 0);
  });

  it('closes the session without emitting on stop', async () => {
    const h = harness(scriptVad([...speech(50), ...silence(50)]));
    await h.feed([...speech(50), ...silence(50)]);
    h.socket.peerMessage(twilioStop());
    assert.equal(h.utterances.length, 1);
  });

  it('streams frames upstream only while it can hear the Caller', async () => {
    const upstream: Buffer[] = [];
    const turnTaking = new TurnTaking({
      vad: scriptVad(speech(10)),
      policy: POLICY,
      detection: 'hybrid',
      observer: {
        onUtterance: () => {},
        onUpstreamFrame: (frame) => upstream.push(frame),
      },
    });
    await turnTaking.receiveAudio(Buffer.alloc(FRAME_BYTES, 0x11));
    turnTaking.startSpeaking();
    await turnTaking.receiveAudio(Buffer.alloc(FRAME_BYTES, 0x22));
    turnTaking.startSpeaking({ watchForBargeIn: true });
    await turnTaking.receiveAudio(Buffer.alloc(FRAME_BYTES, 0x33));
    turnTaking.startListening();
    await turnTaking.receiveAudio(Buffer.alloc(FRAME_BYTES, 0x44));
    assert.deepEqual(upstream, [
      Buffer.alloc(FRAME_BYTES, 0x11),
      Buffer.alloc(FRAME_BYTES, 0x33),
      Buffer.alloc(FRAME_BYTES, 0x44),
    ]);
  });

  it('announces the Caller taking the floor once per utterance', async () => {
    const pattern = [...speech(50), ...silence(50), ...speech(50), ...silence(50)];
    const h = harness(scriptVad(pattern));
    await h.feed([...speech(50), ...silence(50)]);
    assert.equal(h.speechStarts, 1);
    h.turnTaking.startListening();
    await h.feed([...speech(50), ...silence(50)]);
    assert.equal(h.speechStarts, 2);
  });

  it('announces the Caller taking the floor even when silence follows the latch', async () => {
    // Exactly 300 ms of speech latches the utterance; the next frame is
    // silence. The live STT channel must still open for the utterance.
    const h = harness(scriptVad([...speech(15), ...silence(60)]));
    await h.feed([...speech(15), ...silence(60)]);
    assert.equal(h.speechStarts, 1);
    assert.equal(h.utterances.length, 1);
  });

  it('hands each utterance its speech-probability stats', async () => {
    const h = harness(scriptVad([...speech(50), ...silence(50)]));
    await h.feed([...speech(50), ...silence(50)]);
    assert.equal(h.stats.length, 1);
    assert.equal(h.stats[0]!.maxScore, 0.9);
    assert.equal(h.stats[0]!.meanScore, 0.9);
    assert.ok(h.stats[0]!.frames > 0);
  });
});
