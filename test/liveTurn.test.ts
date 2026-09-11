import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CallStore } from '../src/calls.ts';
import { LiveCallSession } from '../src/live.ts';
import type { Vad } from '../src/endpoint.ts';
import type { Assistant, AssistantContext, Transcriber } from '../src/app.ts';
import { HOLD_ASSISTANT_LINE } from '../src/app.ts';
import type { Tts } from '../src/tts.ts';

const FRAME_BYTES = 160;
const POLICY = { silenceMs: 700, minSpeechMs: 300, maxUtteranceMs: 30000, threshold: 0.5, latchDipMs: 200 };
const GUIDE = { raw: '# Clinic Guide — Maple Clinic\n', name: 'Maple Clinic' };
const AVAILABILITY = 'AVAILABILITY (fetched live — only these slots exist)\n- 2026-09-30 09:30 Appointment with Bob Gowda at Bobby Clinic';

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
      return { audio: Buffer.from([0xff]) };
    },
  };
  return { tts, texts, completions };
}

function queueTranscriber(texts: string[]): Transcriber {
  let n = 0;
  return {
    transcribe: async () => {
      const text = texts[Math.min(n, texts.length - 1)] ?? '';
      n += 1;
      return { text, noSpeech: false };
    },
  };
}

async function feed(live: LiveCallSession, frames: number): Promise<void> {
  for (let i = 0; i < frames; i++) {
    await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
  }
  await live.flush();
}

describe('live full Turn (ticket 11)', () => {
  it('runs multi-turn conversation inside one session with grounded replies', async () => {
    const calls = new CallStore();
    const { tts, texts, completions } = stubTts();
    const seenCtx: AssistantContext[] = [];
    const turns: { excerpt: string; reply: string }[] = [];
    const assistant: Assistant = {
      reply: async () => ({ text: '', endCall: false }),
      replyStream: async function* (ctx: AssistantContext) {
        seenCtx.push(ctx);
        if (ctx.transcript.includes('hours')) {
          yield 'We are open Monday to Friday. ';
        } else {
          yield 'Wednesday at ten is free. ';
        }
      },
    };
    const live = new LiveCallSession({
      identity: { callSid: 'CA11multi', streamSid: 'MZ11multi' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50), ...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: queueTranscriber(['what are your hours', 'book Wednesday morning']),
      tts,
      guide: GUIDE,
      availability: AVAILABILITY,
      assistant,
      calls,
      logTurn: (e) => turns.push({ excerpt: e.excerpt, reply: e.reply }),
      onPlaybackComplete: (t) => completions.push(t),
    });
    await feed(live, 100);
    await feed(live, 100);
    assert.equal(calls.get('CA11multi').turn, 2);
    const history = calls.get('CA11multi').history;
    assert.equal(history.length, 4);
    assert.deepEqual(
      history.map((h) => h.role),
      ['caller', 'receptionist', 'caller', 'receptionist'],
    );
    assert.equal(turns.length, 2);
    assert.equal(turns[0]!.excerpt, 'what are your hours');
    assert.match(turns[0]!.reply, /Monday to Friday/);
    assert.equal(turns[1]!.excerpt, 'book Wednesday morning');
    assert.match(turns[1]!.reply, /Wednesday/);
    assert.ok(texts.some((t) => t.includes('Monday to Friday')));
    assert.ok(texts.some((t) => t.includes('Wednesday')));
    assert.equal(completions.length, texts.length);
    // Grounding: assistant saw the guide, could read live availability, and saw growing history.
    assert.equal(seenCtx.length, 2);
    assert.equal(seenCtx[0]!.guide.name, 'Maple Clinic');
    assert.equal(await seenCtx[0]!.getAvailability(), AVAILABILITY);
    assert.equal(seenCtx[1]!.history.length, 3);
  });

  it('speaks the first sentence before the full reply completes', async () => {
    const calls = new CallStore();
    const texts: string[] = [];
    let streamedEarly = false;
    const tts: Tts = {
      synthesize: async (text: string) => {
        texts.push(text);
        return { audio: Buffer.from([0xff]) };
      },
    };
    const assistant: Assistant = {
      reply: async () => ({ text: '', endCall: false }),
      replyStream: async function* () {
        yield 'First sentence here. ';
        for (let i = 0; i < 50; i++) {
          if (texts.length >= 1) break;
          await new Promise((r) => setTimeout(r, 10));
        }
        streamedEarly = texts.length >= 1;
        yield 'Second sentence follows.';
      },
    };
    const live = new LiveCallSession({
      identity: { callSid: 'CA11cut', streamSid: 'MZ11cut' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: queueTranscriber(['hello']),
      tts,
      guide: GUIDE,
      availability: AVAILABILITY,
      assistant,
      calls,
    });
    await feed(live, 100);
    assert.equal(streamedEarly, true);
    assert.equal(texts.length, 2);
    assert.equal(texts[0], 'First sentence here.');
    assert.equal(texts[1], 'Second sentence follows.');
  });

  it('speaks a hold line and logs phases when the assistant is slow', async () => {
    const calls = new CallStore();
    const { tts, texts } = stubTts();
    const phases: Record<string, unknown>[] = [];
    const assistant: Assistant = {
      reply: async () => ({ text: '', endCall: false }),
      replyStream: async function* () {
        await new Promise((r) => setTimeout(r, 60));
        yield 'Wednesday at ten is free. ';
      },
    };
    const live = new LiveCallSession({
      identity: { callSid: 'CA11slow', streamSid: 'MZ11slow' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: queueTranscriber(['book Wednesday']),
      tts,
      guide: GUIDE,
      availability: AVAILABILITY,
      holdAfterMs: 20,
      assistant,
      calls,
      logSession: (e) => phases.push(e),
    });
    await feed(live, 100);
    assert.equal(texts[0], HOLD_ASSISTANT_LINE);
    assert.ok(texts.some((t) => t.includes('Wednesday')));
    const names = phases.map((p) => `${String(p.phase)}:${String(p.event)}`);
    assert.ok(names.includes('transcribe:done'));
    assert.ok(names.includes('assistant:hold'));
    assert.ok(names.includes('assistant:first-token'));
    assert.ok(names.includes('tts:done'));
    assert.equal(phases.every((p) => p.kind === 'phase' && p.callSid === 'CA11slow'), true);
  });

  it('never reads the booking system for a greeting and reads it lazily when asked', async () => {
    const calls = new CallStore();
    const { tts } = stubTts();
    const phases: Record<string, unknown>[] = [];
    let reads = 0;
    const replies = ['Hi! How can I help?', 'Wednesday at ten is free.'];
    let replyIndex = 0;
    const assistant: Assistant = {
      reply: async () => ({ text: '', endCall: false }),
      replyStream: async function* (ctx: AssistantContext) {
        if (ctx.transcript.includes('book')) {
          const block = await ctx.getAvailability();
          assert.equal(block, AVAILABILITY);
        }
        yield `${replies[Math.min(replyIndex, replies.length - 1)]} `;
        replyIndex += 1;
      },
    };
    const live = new LiveCallSession({
      identity: { callSid: 'CA11lazy', streamSid: 'MZ11lazy' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50), ...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: queueTranscriber(['hello', 'book Wednesday morning']),
      tts,
      guide: GUIDE,
      availability: async () => {
        reads += 1;
        return AVAILABILITY;
      },
      assistant,
      calls,
      logSession: (e) => phases.push(e),
    });
    await feed(live, 100);
    assert.equal(reads, 0, 'a greeting must not touch the booking system');
    await feed(live, 100);
    assert.equal(reads, 1);
    const names = phases.map((p) => `${String(p.phase)}:${String(p.event)}`);
    assert.equal(names.includes('availability:start'), true);
    assert.equal(names.includes('availability:done'), true);
  });

  it('proposes a booking at most once with patient name and phone', async () => {
    const calls = new CallStore();
    const { tts, texts } = stubTts();
    const proposed: { slot: Record<string, string> }[] = [];
    const seenAvailability: string[] = [];
    const assistant: Assistant = {
      reply: async () => ({ text: '', endCall: false }),
      replyStream: async function* (ctx: AssistantContext) {
        seenAvailability.push(await ctx.getAvailability());
        const outcome = await ctx.proposeBooking({
          service: 'Appointment',
          location: 'Bobby Clinic',
          date: '2026-09-30',
          time: '09:30',
          callerName: 'Asha',
          callerPhone: '+911234567890',
        });
        assert.equal(outcome.ok, true);
        yield 'Booked for Wednesday at half past nine. ';
      },
    };
    const live = new LiveCallSession({
      identity: { callSid: 'CA11book', streamSid: 'MZ11book' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: queueTranscriber(['yes book Wednesday half past nine, I am Asha']),
      tts,
      guide: GUIDE,
      availability: AVAILABILITY,
      assistant,
      calls,
      onProposeBooking: async (args) => {
        proposed.push({ slot: { ...args.slot } });
        return { ok: true };
      },
    });
    await feed(live, 100);
    assert.equal(proposed.length, 1);
    assert.equal(proposed[0]!.slot.callerName, 'Asha');
    assert.equal(proposed[0]!.slot.callerPhone, '+911234567890');
    assert.equal(seenAvailability[0], AVAILABILITY);
    assert.ok(texts.some((t) => t.includes('Booked for Wednesday')));
    const history = calls.get('CA11book').history;
    assert.equal(history.length, 2);
    assert.equal(history[1]!.role, 'receptionist');
  });
});
