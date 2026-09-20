import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CallStore } from '../src/calls.ts';
import { LiveCallSession } from '../src/live.ts';
import { attachStreamSocket } from '../src/stream.ts';
import { BOOKING_FAILURE_LINE, FAILURE_LINE, type Assistant, type FailureEvent, type Transcriber, type TurnEvent } from '../src/app.ts';
import type { Vad } from '../src/endpoint.ts';
import type { Tts } from '../src/tts.ts';
import { FakeSocket, twilioMedia, twilioStart } from './fakeStream.ts';

const FRAME_BYTES = 160;
const POLICY = { silenceMs: 700, minSpeechMs: 300, maxUtteranceMs: 30000, threshold: 0.5, latchDipMs: 200 };
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

  it('bounds a hanging availability read, says the system line, and keeps the call alive', async () => {
    const calls = new CallStore();
    const { tts, texts } = stubTts();
    const phases: Record<string, unknown>[] = [];
    const failures: FailureEvent[] = [];
    const live = new LiveCallSession({
      identity: { callSid: 'CA12hangavail', streamSid: 'MZ12hangavail' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: { transcribe: async () => ({ text: 'any slot?', noSpeech: false }) },
      tts,
      guide: GUIDE,
      assistant: {
        reply: async () => ({ text: '', endCall: false }),
        replyStream: async function* () {
          yield 'unused';
        },
      },
      availability: () => new Promise<string>(() => {}),
      availabilityTimeoutMs: 30,
      calls,
      logSession: (e) => phases.push(e),
      logFailure: (e) => failures.push(e),
    });
    await feed(live, 100);
    assert.ok(texts.includes(BOOKING_FAILURE_LINE));
    assert.equal(failures.length, 1, 'the availability failure is logged for handoff');
    assert.match(failures[0]!.detail ?? '', /availability-error: availability-timeout after 30ms/);
    assert.equal(live.isClosed, false, 'availability failure must not end the call');
    const names = phases.map((p) => `${String(p.phase)}:${String(p.event)}`);
    assert.ok(names.includes('availability:start'));
    assert.ok(names.includes('availability:error'));
    assert.ok(names.includes('availability:turn-error'));
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

  it('booking write failures are logged, speak the booking-system line, and end', async () => {
    const calls = new CallStore();
    const order: string[] = [];
    const { tts, texts } = stubTts(order);
    const turns: TurnEvent[] = [];
    const failures: FailureEvent[] = [];
    let attempts = 0;
    let transcriptions = 0;
    const live = new LiveCallSession({
      identity: { callSid: 'CA12book', streamSid: 'MZ12book' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50), ...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: {
        transcribe: async () => {
          transcriptions += 1;
          return transcriptions === 1
            ? { text: 'book Wednesday at 9:30, my name is Asha, 9840950950', noSpeech: false }
            : { text: 'yes', noSpeech: false };
        },
      },
      tts,
      guide: GUIDE,
      availability: 'AVAILABILITY\n- 2026-09-30 09:30 Appointment with Bob Gowda at Bobby Clinic',
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
    await feed(live, 100);
    assert.equal(attempts, 1);
    assert.equal(failures.length, 1);
    assert.match(failures[0]!.detail ?? '', /booking-error: picktime save blew up/);
    assert.ok(texts.includes(BOOKING_FAILURE_LINE));
    assert.ok(order.indexOf('failure-log') < order.indexOf(`tts:${BOOKING_FAILURE_LINE}`));
    assert.equal(turns.at(-1)!.reply, BOOKING_FAILURE_LINE);
    assert.equal(live.isClosed, true);
  });

  it('a model proposeBooking never reaches the writer', async () => {
    const calls = new CallStore();
    const { tts, texts } = stubTts();
    let attempts = 0;
    const assistant: Assistant = {
      reply: async () => ({ text: '', endCall: false }),
      replyStream: async function* (ctx) {
        const outcome = await ctx.proposeBooking({
          service: 'Appointment',
          location: 'Bobby Clinic',
          date: '2026-09-30',
          time: '09:30',
          callerName: 'Asha',
          callerPhone: '+911234567890',
        });
        assert.equal(outcome.ok, false);
        yield 'The controller confirms that first. ';
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
    assert.equal(attempts, 0, 'only the controller authorizes a write');
    assert.equal(live.isClosed, false);
    assert.ok(texts.some((t) => t.includes('controller confirms')));
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

  describe('REST hangup on session-end close', () => {
    it('an assistant failure ends the caller\'s phone call after the failure line', async () => {
      const calls = new CallStore();
      const { tts } = stubTts();
      const hangups: string[] = [];
      const live = new LiveCallSession({
        identity: { callSid: 'CA12hangup', streamSid: 'MZ12hangup' },
        sendAudio: () => {},
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
        logFailure: () => {},
        hangupCall: async (callSid) => {
          hangups.push(callSid);
        },
      });
      await feed(live, 100);
      assert.deepEqual(hangups, ['CA12hangup'], 'the dead session must hang the call up');
    });

    it('a goodbye close hangs the call up too', async () => {
      const calls = new CallStore();
      const { tts } = stubTts();
      const hangups: string[] = [];
      const live = new LiveCallSession({
        identity: { callSid: 'CA12bye', streamSid: 'MZ12bye' },
        sendAudio: () => {},
        vad: scriptVad([...speech(50), ...silence(50), ...speech(50), ...silence(50), ...speech(50), ...silence(50)]),
        policy: POLICY,
        transcriber: { transcribe: async () => ({ text: '', noSpeech: true }) },
        tts,
        guide: GUIDE,
        calls,
        hangupCall: async (callSid) => {
          hangups.push(callSid);
        },
      });
      await feed(live, 100);
      await feed(live, 100);
      await feed(live, 100);
      assert.equal(live.isClosed, true);
      assert.deepEqual(hangups, ['CA12bye']);
    });

    it('a caller-hangup close never re-hangs-up', async () => {
      const calls = new CallStore();
      const { tts } = stubTts();
      let hangups = 0;
      const live = new LiveCallSession({
        identity: { callSid: 'CA12self', streamSid: 'MZ12self' },
        sendAudio: () => {},
        vad: scriptVad([...speech(50), ...silence(50)]),
        policy: POLICY,
        transcriber: { transcribe: async () => ({ text: '', noSpeech: true }) },
        tts,
        guide: GUIDE,
        calls,
        hangupCall: async () => {
          hangups += 1;
        },
      });
      await feed(live, 100);
      live.close('socket-closed');
      assert.equal(hangups, 0, 'Twilio already ended the stream; no REST hangup');
    });
  });
});
