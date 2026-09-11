import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CallStore } from '../src/calls.ts';
import { LiveCallSession } from '../src/live.ts';
import { attachStreamSocket } from '../src/stream.ts';
import type { Vad } from '../src/endpoint.ts';
import type { Transcriber } from '../src/app.ts';
import type { Tts } from '../src/tts.ts';
import { FakeSocket, twilioMedia, twilioStart } from './fakeStream.ts';

const FRAME_BYTES = 160;
const POLICY = { silenceMs: 700, minSpeechMs: 300, maxUtteranceMs: 30000, threshold: 0.5 };
const GUIDE = { raw: '# Clinic Guide — Maple Clinic\n', name: 'Maple Clinic' };

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

const speech = (n: number): ('speech' | 'silence')[] => Array(n).fill('speech');
const silence = (n: number): ('speech' | 'silence')[] => Array(n).fill('silence');

function stubTts() {
  const texts: string[] = [];
  const completions: string[] = [];
  const tts: Tts = {
    synthesize: async (text: string) => {
      texts.push(text);
      return { audio: Buffer.from([0xff, 0xff, 0xff]) };
    },
  };
  return { tts, texts, completions };
}

function stubTranscriber(text: string, seen: { audio: Buffer[]; contentType: string[] }): Transcriber {
  return {
    transcribe: async (audio: Buffer, contentType: string) => {
      seen.audio.push(audio);
      seen.contentType.push(contentType);
      return { text, noSpeech: false };
    },
  };
}

describe('live greeting (ticket 10)', () => {
  it('speaks the greeting on open through the session TTS path with a completion event', async () => {
    const socket = new FakeSocket();
    const calls = new CallStore();
    const { tts, texts, completions } = stubTts();
    const seen = { audio: [] as Buffer[], contentType: [] as string[] };
    let live: LiveCallSession | null = null;
    const session = attachStreamSocket(socket, {
      onAudio: (_id, audio) => void live?.receiveAudio(audio),
      onClose: () => {},
      onOpen: (identity) => void live?.open(),
    });
    live = new LiveCallSession({
      identity: { callSid: 'CAgreet', streamSid: 'MZgreet' },
      sendAudio: (b) => session.sendAudio(b),
      vad: scriptVad(silence(10)),
      policy: POLICY,
      transcriber: stubTranscriber('hi', seen),
      tts,
      guide: GUIDE,
      calls,
      onPlaybackComplete: (text) => completions.push(text),
    });
    socket.peerMessage(twilioStart({ callSid: 'CAgreet', streamSid: 'MZgreet' }));
    await live.flush();
    await waitFor(() => completions.length === 1, 'greeting spoken');
    assert.ok(texts[0]!.includes('Maple Clinic'));
    assert.equal(completions.length, 1);
    const out = socket.sentJson() as { event: string; media: { payload: string } }[];
    assert.ok(out.length >= 1 && out[0]!.event === 'media');
    assert.ok((out[0]!.media.payload as string).length > 0);
  });
});

describe('live transcription (ticket 09)', () => {
  it('converts the buffered utterance and transcribes via the existing seam', async () => {
    const calls = new CallStore();
    const { tts } = stubTts();
    const seen = { audio: [] as Buffer[], contentType: [] as string[] };
    const live = new LiveCallSession({
      identity: { callSid: 'CA9', streamSid: 'MZ9' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: stubTranscriber('what are your hours', seen),
      tts,
      guide: GUIDE,
      calls,
    });
    for (let i = 0; i < 100; i++) {
      await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
    }
    await live.flush();
    assert.equal(seen.audio.length, 1);
    assert.equal(seen.audio[0]!.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(seen.contentType[0], 'audio/wav');
    const history = calls.get('CA9').history;
    assert.equal(history.length, 1);
    assert.equal(history[0]!.role, 'caller');
    assert.equal(history[0]!.text, 'what are your hours');
    assert.equal(calls.get('CA9').turn, 1);
  });

  it('counts empty audio as one miss and reprompts through TTS', async () => {
    const calls = new CallStore();
    const { tts, texts, completions } = stubTts();
    const live = new LiveCallSession({
      identity: { callSid: 'CAmiss', streamSid: 'MZmiss' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: { transcribe: async () => ({ text: '   ', noSpeech: false }) },
      tts,
      guide: GUIDE,
      calls,
      onPlaybackComplete: (t) => completions.push(t),
    });
    for (let i = 0; i < 100; i++) {
      await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
    }
    await live.flush();
    assert.equal(calls.get('CAmiss').turn, 1);
    assert.ok(texts[0]!.includes("didn't catch that"));
    assert.equal(completions.length, 1);
    assert.equal(calls.get('CAmiss').history.length, 0);
  });

  it('says goodbye and closes after the second miss', async () => {
    const calls = new CallStore();
    const { tts, texts } = stubTts();
    let closed: string | null = null;
    const live = new LiveCallSession({
      identity: { callSid: 'CAbye', streamSid: 'MZbye' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50), ...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: { transcribe: async () => ({ text: '', noSpeech: true }) },
      tts,
      guide: GUIDE,
      calls,
      onClose: (reason) => {
        closed = reason;
      },
    });
    for (let i = 0; i < 100; i++) {
      await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
    }
    await live.flush();
    for (let i = 0; i < 100; i++) {
      await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
    }
    await live.flush();
    assert.equal(texts.length, 2);
    assert.match(texts[1]!, /Goodbye/);
    assert.equal(closed, 'goodbye');
  });
});

describe('playback tracking (ticket 10)', () => {
  it('every spoken reply emits a completion and restarts endpointing after', async () => {
    const calls = new CallStore();
    const completions: string[] = [];
    let release!: (v: { audio: Buffer }) => void;
    const gate = new Promise<{ audio: Buffer }>((resolve) => {
      release = resolve;
    });
    const blockingTts: Tts = {
      synthesize: async (text: string) => {
        if (text === 'blocked reply') await gate;
        return { audio: Buffer.from([0xff]) };
      },
    };
    const live = new LiveCallSession({
      identity: { callSid: 'CAplay', streamSid: 'MZplay' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: stubTranscriber('hi', { audio: [], contentType: [] }),
      tts: blockingTts,
      guide: GUIDE,
      calls,
      onPlaybackComplete: (t) => completions.push(t),
    });
    const speaking = live.speak('blocked reply');
    // Inbound audio during playback is discarded: no utterance can complete.
    for (let i = 0; i < 100; i++) {
      await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
    }
    await live.flush();
    assert.equal(completions.length, 0);
    release({ audio: Buffer.from([0xff]) });
    await speaking;
    assert.deepEqual(completions, ['blocked reply']);
    // After playback the endpoint timer restarts clean: next utterance endpoints.
    for (let i = 0; i < 100; i++) {
      await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
    }
    await live.flush();
    assert.equal(calls.get('CAplay').history.length, 1);
  });

  it('verifies text in to audio out plus completion through the fake driver', async () => {
    const socket = new FakeSocket();
    const calls = new CallStore();
    const { tts, texts, completions } = stubTts();
    const seen = { audio: [] as Buffer[], contentType: [] as string[] };
    const session = attachStreamSocket(socket, { onAudio: () => {}, onClose: () => {} });
    session.open({ callSid: 'CAdrv', streamSid: 'MZdrv' });
    const live = new LiveCallSession({
      identity: { callSid: 'CAdrv', streamSid: 'MZdrv' },
      sendAudio: (b) => session.sendAudio(b),
      vad: scriptVad(silence(5)),
      policy: POLICY,
      transcriber: stubTranscriber('hi', seen),
      tts,
      guide: GUIDE,
      calls,
      onPlaybackComplete: (t) => completions.push(t),
    });
    assert.equal(texts.length, 0);
    await live.speak('hello there');
    assert.deepEqual(texts, ['hello there']);
    assert.deepEqual(completions, ['hello there']);
    assert.ok(socket.sent.length >= 1);
    socket.peerMessage(twilioMedia(Buffer.alloc(FRAME_BYTES, 0xff).toString('base64')));
  });
});

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
