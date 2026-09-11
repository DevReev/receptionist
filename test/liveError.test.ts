import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CallStore } from '../src/calls.ts';
import { LiveCallSession } from '../src/live.ts';
import { attachStreamSocket } from '../src/stream.ts';
import { FAILURE_LINE, type Assistant, type FailureEvent, type Transcriber, type TurnEvent } from '../src/app.ts';
import type { Vad } from '../src/endpoint.ts';
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

function stubTts(order?: string[]) {
  const texts: string[] = [];
  const tts: Tts = {
    synthesize: async (text: string) => {
      texts.push(text);
      order?.push(`tts:${text}`);
      return { audio: Buffer.from([0xff]) };
    },
  };
  return { tts, texts };
}

async function feed(live: LiveCallSession, frames: number): Promise<void> {
  for (let i = 0; i < frames; i++) {
    await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
  }
  await live.flush();
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('live error contract (ticket 12)', () => {
  it('reprompts twice, then hands off on the third miss with all turns and one failure logged', async () => {
    const calls = new CallStore();
    const { tts, texts } = stubTts();
    const turns: TurnEvent[] = [];
    const failures: FailureEvent[] = [];
    let closed: string | null = null;
    const live = new LiveCallSession({
      identity: { callSid: 'CA12miss', streamSid: 'MZ12miss' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50), ...speech(50), ...silence(50), ...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: { transcribe: async () => ({ text: '', noSpeech: true }) },
      tts,
      guide: GUIDE,
      calls,
      logTurn: (e) => turns.push(e),
      logFailure: (e) => failures.push(e),
      onClose: (reason) => {
        closed = reason;
      },
    });
    await feed(live, 100);
    await feed(live, 100);
    await feed(live, 100);
    assert.equal(texts.length, 3);
    assert.match(texts[0]!, /didn't catch that/);
    assert.match(texts[1]!, /didn't catch that/);
    assert.match(texts[2]!, /Goodbye/);
    assert.equal(closed, 'goodbye');
    assert.equal(turns.length, 3);
    assert.ok(turns.every((t) => t.miss === true));
    assert.equal(turns[0]!.endCall, false);
    assert.equal(turns[1]!.endCall, false);
    assert.equal(turns[2]!.endCall, true);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.turn, 3);
    assert.equal(failures[0]!.reason, 'low-confidence');
  });

  it('mid-turn assistant failure logs first, then speaks clinic-will-confirm and ends the session', async () => {
    const calls = new CallStore();
    const order: string[] = [];
    const { tts, texts } = stubTts(order);
    const turns: TurnEvent[] = [];
    const failures: FailureEvent[] = [];
    const failingAssistant: Assistant = {
      reply: async () => ({ text: '', endCall: false }),
      replyStream: async function* () {
        yield 'partial ';
        throw new Error('llm timeout');
      },
    };
    const live = new LiveCallSession({
      identity: { callSid: 'CA12fail', streamSid: 'MZ12fail' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: { transcribe: async () => ({ text: 'book Wednesday', noSpeech: false }) },
      tts,
      guide: GUIDE,
      assistant: failingAssistant,
      calls,
      logTurn: (e) => turns.push(e),
      logFailure: (e) => {
        failures.push(e);
        order.push('failure-log');
      },
    });
    await feed(live, 100);
    assert.equal(failures.length, 1);
    assert.match(failures[0]!.detail ?? '', /assistant-error: llm timeout/);
    assert.ok(texts.includes(FAILURE_LINE));
    assert.ok(order.indexOf('failure-log') < order.indexOf(`tts:${FAILURE_LINE}`), `log must precede speech: ${order.join(' | ')}`);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.reply, FAILURE_LINE);
    assert.equal(turns[0]!.endCall, true);
    assert.equal(live.isClosed, true);
  });

  it('mid-turn TTS failure still logs first and ends the session on the clinic-will-confirm line', async () => {
    const calls = new CallStore();
    const order: string[] = [];
    const texts: string[] = [];
    const tts: Tts = {
      synthesize: async (text: string) => {
        texts.push(text);
        if (text === FAILURE_LINE) {
          order.push(`tts:${text}`);
          return { audio: Buffer.from([0xff]) };
        }
        throw new Error('tts boom');
      },
    };
    const turns: TurnEvent[] = [];
    const failures: FailureEvent[] = [];
    const assistant: Assistant = {
      reply: async () => ({ text: '', endCall: false }),
      replyStream: async function* () {
        yield 'Hello there. ';
      },
    };
    const live = new LiveCallSession({
      identity: { callSid: 'CA12tts', streamSid: 'MZ12tts' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: { transcribe: async () => ({ text: 'hi', noSpeech: false }) },
      tts,
      guide: GUIDE,
      assistant,
      calls,
      logTurn: (e) => turns.push(e),
      logFailure: (e) => {
        failures.push(e);
        order.push('failure-log');
      },
    });
    await feed(live, 100);
    assert.equal(failures.length, 1);
    assert.match(failures[0]!.detail ?? '', /tts-error/);
    assert.ok(texts.includes(FAILURE_LINE));
    assert.ok(order.indexOf('failure-log') < order.indexOf(`tts:${FAILURE_LINE}`));
    assert.equal(turns[0]!.reply, FAILURE_LINE);
    assert.equal(live.isClosed, true);
  });

  it('availability failure logs first, then speaks clinic-will-confirm and ends', async () => {
    const calls = new CallStore();
    const order: string[] = [];
    const { tts, texts } = stubTts(order);
    const turns: TurnEvent[] = [];
    const failures: FailureEvent[] = [];
    let assistantRan = false;
    const assistant: Assistant = {
      reply: async () => ({ text: '', endCall: false }),
      replyStream: async function* () {
        assistantRan = true;
        yield 'should never speak. ';
      },
    };
    const live = new LiveCallSession({
      identity: { callSid: 'CA12avail', streamSid: 'MZ12avail' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: { transcribe: async () => ({ text: 'any morning free', noSpeech: false }) },
      tts,
      guide: GUIDE,
      assistant,
      availability: () => {
        throw new Error('picktime down');
      },
      calls,
      logTurn: (e) => turns.push(e),
      logFailure: (e) => {
        failures.push(e);
        order.push('failure-log');
      },
    });
    await feed(live, 100);
    assert.equal(assistantRan, false);
    assert.equal(failures.length, 1);
    assert.match(failures[0]!.detail ?? '', /availability-error: picktime down/);
    assert.ok(texts.includes(FAILURE_LINE));
    assert.ok(order.indexOf('failure-log') < order.indexOf(`tts:${FAILURE_LINE}`));
    assert.equal(turns[0]!.reply, FAILURE_LINE);
    assert.equal(live.isClosed, true);
  });

  it('caller hangup mid-turn logs the partial turn', async () => {
    const calls = new CallStore();
    const { tts, texts } = stubTts();
    const turns: TurnEvent[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const assistant: Assistant = {
      reply: async () => ({ text: '', endCall: false }),
      replyStream: async function* () {
        yield 'First part. ';
        await gate;
        yield 'Second part.';
      },
    };
    const transcriber: Transcriber = { transcribe: async () => ({ text: 'tell me hours', noSpeech: false }) };
    const live = new LiveCallSession({
      identity: { callSid: 'CA12hang', streamSid: 'MZ12hang' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber,
      tts,
      guide: GUIDE,
      assistant,
      calls,
      logTurn: (e) => turns.push(e),
      logFailure: () => {},
    });
    const feedPromise = feed(live, 100);
    await waitFor(() => texts.length >= 1, 'first sentence spoken');
    live.close('socket-closed');
    release();
    await feedPromise;
    await live.flush();
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.excerpt, 'tell me hours');
    assert.match(turns[0]!.reply, /First part/);
    assert.equal(turns[0]!.endCall, true);
    assert.equal(live.isClosed, true);
  });

  it('booking write failures stay single-attempt: log first, speak clinic-will-confirm, end', async () => {
    const calls = new CallStore();
    const order: string[] = [];
    const { tts, texts } = stubTts(order);
    const turns: TurnEvent[] = [];
    const failures: FailureEvent[] = [];
    let attempts = 0;
    const assistant: Assistant = {
      reply: async () => ({ text: '', endCall: false }),
      replyStream: async function* (ctx) {
        yield 'One moment. ';
        await ctx.proposeBooking({
          service: 'Appointment',
          date: '2026-09-30',
          time: '09:30',
          callerName: 'Asha',
          callerPhone: '+911234567890',
        });
      },
    };
    const live = new LiveCallSession({
      identity: { callSid: 'CA12book', streamSid: 'MZ12book' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: { transcribe: async () => ({ text: 'yes book it', noSpeech: false }) },
      tts,
      guide: GUIDE,
      assistant,
      calls,
      onProposeBooking: async () => {
        attempts += 1;
        throw new Error('picktime save blew up');
      },
      logTurn: (e) => turns.push(e),
      logFailure: (e) => {
        failures.push(e);
        order.push('failure-log');
      },
    });
    await feed(live, 100);
    assert.equal(attempts, 1);
    assert.equal(failures.length, 1);
    assert.ok(texts.includes(FAILURE_LINE));
    assert.ok(order.indexOf('failure-log') < order.indexOf(`tts:${FAILURE_LINE}`));
    assert.equal(turns[0]!.reply, FAILURE_LINE);
    assert.equal(live.isClosed, true);
  });

  it('a second booking proposal in one turn never reaches the writer', async () => {
    const calls = new CallStore();
    const { tts } = stubTts();
    let attempts = 0;
    const assistant: Assistant = {
      reply: async () => ({ text: '', endCall: false }),
      replyStream: async function* (ctx) {
        const first = await ctx.proposeBooking({
          service: 'Appointment',
          date: '2026-09-30',
          time: '09:30',
          callerName: 'Asha',
          callerPhone: '+911234567890',
        });
        assert.equal(first.ok, true);
        const second = await ctx.proposeBooking({
          service: 'Appointment',
          date: '2026-09-30',
          time: '09:30',
          callerName: 'Asha',
          callerPhone: '+911234567890',
        });
        assert.equal(second.ok, false);
        yield 'Booked once. ';
      },
    };
    const live = new LiveCallSession({
      identity: { callSid: 'CA12once', streamSid: 'MZ12once' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: { transcribe: async () => ({ text: 'yes book it', noSpeech: false }) },
      tts,
      guide: GUIDE,
      assistant,
      calls,
      onProposeBooking: async () => {
        attempts += 1;
        return { ok: true };
      },
    });
    await feed(live, 100);
    assert.equal(attempts, 1);
    assert.equal(live.isClosed, false);
  });

  it('fake driver: mid-turn failure is logged before audio leaves the socket and the session ends', async () => {
    const socket = new FakeSocket();
    const calls = new CallStore();
    const order: string[] = [];
    const turns: TurnEvent[] = [];
    const failures: FailureEvent[] = [];
    let closed: string | null = null;
    const { tts } = stubTts(order);
    let live: LiveCallSession | null = null;
    const session = attachStreamSocket(socket, {
      onAudio: (_id, audio) => void live?.receiveAudio(audio),
      onClose: (_id, reason) => live?.close(reason),
      onOpen: (identity) => {
        live = new LiveCallSession({
          identity,
          sendAudio: (b) => session.sendAudio(b),
          vad: scriptVad([...speech(50), ...silence(50)]),
          policy: POLICY,
          transcriber: { transcribe: async () => ({ text: 'book now', noSpeech: false }) },
          tts,
          guide: GUIDE,
          assistant: {
            reply: async () => ({ text: '', endCall: false }),
            replyStream: async function* () {
              throw new Error('llm down');
            },
          },
          calls,
          logTurn: (e) => turns.push(e),
          logFailure: (e) => {
            failures.push(e);
            order.push('failure-log');
          },
          onPlaybackComplete: (t) => order.push(`played:${t}`),
          onClose: (reason) => {
            closed = reason;
          },
        });
      },
    });
    socket.peerMessage(twilioStart({ callSid: 'CA12sock', streamSid: 'MZ12sock' }));
    const frame = Buffer.alloc(FRAME_BYTES, 0xff).toString('base64');
    for (let i = 0; i < 100; i++) socket.peerMessage(twilioMedia(frame));
    await waitFor(() => (live as unknown as LiveCallSession | null)?.isClosed === true, 'session closed');
    await (live as unknown as LiveCallSession).flush();
    assert.equal(failures.length, 1);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.reply, FAILURE_LINE);
    assert.equal(closed, 'failure');
    assert.ok(order.indexOf('failure-log') < order.indexOf(`played:${FAILURE_LINE}`), `log before speech: ${order.join(' | ')}`);
    const out = socket.sentJson() as { event: string }[];
    assert.ok(out.some((m) => m.event === 'media'));
  });
});
