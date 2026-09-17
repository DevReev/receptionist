import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CallStore } from '../src/calls.ts';
import { LiveCallSession } from '../src/live.ts';
import type { Vad } from '../src/endpoint.ts';
import type { Assistant, AssistantContext, FailureEvent, Transcriber } from '../src/app.ts';
import { greetingFor, HOLD_ASSISTANT_LINE, REPROMPT_LINE } from '../src/app.ts';
import type { RealtimeStt } from '../src/sarvamRealtime.ts';
import type { TraceEvent } from '../src/trace.ts';
import type { PlaybackResult } from '../src/transport.ts';
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
    assert.match(turns[1]!.reply, /name/i, 'the controller asks for the missing name deterministically');
    assert.ok(texts.some((t) => t.includes('Monday to Friday')));
    assert.ok(texts.some((t) => /name/i.test(t)));
    assert.equal(completions.length, texts.length);
    // The FAQ turn is model-worded; the availability Turn is controller-owned.
    assert.equal(seenCtx.length, 1);
    assert.equal(seenCtx[0]!.guide.name, 'Maple Clinic');
    assert.equal(await seenCtx[0]!.getAvailability(), AVAILABILITY);
    assert.equal(seenCtx[0]!.history.length, 1);
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

  it('keeps draining LLM tokens while the first sentence is synthesized', async () => {
    const calls = new CallStore();
    let startTts!: () => void;
    const ttsStarted = new Promise<void>((resolve) => {
      startTts = resolve;
    });
    let releaseTts!: () => void;
    const ttsGate = new Promise<void>((resolve) => {
      releaseTts = resolve;
    });
    let secondSentenceYielded = false;
    const tts: Tts = {
      synthesize: async (text: string) => {
        if (text === 'First sentence here.') {
          startTts();
          await ttsGate;
        }
        return { audio: Buffer.from([0xff]) };
      },
    };
    const live = new LiveCallSession({
      identity: { callSid: 'CA11drain', streamSid: 'MZ11drain' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: queueTranscriber(['hello']),
      tts,
      guide: GUIDE,
      assistant: {
        reply: async () => ({ text: '', endCall: false }),
        replyStream: async function* () {
          yield 'First sentence here. ';
          secondSentenceYielded = true;
          yield 'Second sentence follows.';
        },
      },
      calls,
    });
    const feeding = feed(live, 100);
    await ttsStarted;
    const drainedBeforeTtsFinished = secondSentenceYielded;
    releaseTts();
    await feeding;
    assert.equal(drainedBeforeTtsFinished, true);
  });

  it('streams TTS chunks to the caller as they are generated', async () => {
    const calls = new CallStore();
    const audio: Buffer[] = [];
    const texts: string[] = [];
    const completions: string[] = [];
    const tts: Tts = {
      synthesize: async (text: string) => {
        texts.push(`rest:${text}`);
        return { audio: Buffer.from([0x00]) };
      },
      synthesizeStream: async function* (text: string) {
        texts.push(`stream:${text}`);
        yield Buffer.from([0x01]);
        yield Buffer.from([0x02]);
      },
    };
    const live = new LiveCallSession({
      identity: { callSid: 'CAttsstream', streamSid: 'MZttsstream' },
      sendAudio: (b) => audio.push(b),
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: queueTranscriber(['hello']),
      tts,
      guide: GUIDE,
      assistant: {
        reply: async () => ({ text: '', endCall: false }),
        replyStream: async function* () {
          yield 'Streamed reply. ';
        },
      },
      calls,
      onPlaybackComplete: (t) => completions.push(t),
    });
    await feed(live, 100);
    assert.deepEqual(texts, ['stream:Streamed reply.']);
    assert.deepEqual(audio, [Buffer.from([0x01]), Buffer.from([0x02])]);
    assert.deepEqual(completions, ['Streamed reply.']);
  });

  it('falls back to request/response TTS when the live stream fails before any audio', async () => {
    const calls = new CallStore();
    const audio: Buffer[] = [];
    const phases: Record<string, unknown>[] = [];
    const texts: string[] = [];
    const tts: Tts = {
      synthesize: async (text: string) => {
        texts.push(text);
        return { audio: Buffer.from([0x09]) };
      },
      synthesizeStream: async function* () {
        throw new Error('sarvam-tts-stream-error');
      },
    };
    const live = new LiveCallSession({
      identity: { callSid: 'CAttsfb', streamSid: 'MZttsfb' },
      sendAudio: (b) => audio.push(b),
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: queueTranscriber(['hello']),
      tts,
      guide: GUIDE,
      assistant: {
        reply: async () => ({ text: '', endCall: false }),
        replyStream: async function* () {
          yield 'Fallback reply. ';
        },
      },
      calls,
      logSession: (e) => phases.push(e),
    });
    await feed(live, 100);
    assert.deepEqual(texts, ['Fallback reply.']);
    assert.deepEqual(audio, [Buffer.from([0x09])]);
    assert.ok(phases.some((p) => p.phase === 'tts' && p.event === 'fallback'));
  });

  it('reprompts instead of going silent when the assistant replies with nothing', async () => {
    const calls = new CallStore();
    const { tts, texts } = stubTts();
    const failures: FailureEvent[] = [];
    const turns: { reply: string; miss: boolean }[] = [];
    let closed: string | null = null;
    const live = new LiveCallSession({
      identity: { callSid: 'CAempty', streamSid: 'MZempty' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: queueTranscriber(['Monday']),
      tts,
      guide: GUIDE,
      assistant: {
        reply: async () => ({ text: '', endCall: false }),
        replyStream: async function* () {
          // The provider returned nothing, even after its retry.
        },
      },
      calls,
      logFailure: (e) => failures.push(e),
      logTurn: (e) => turns.push({ reply: e.reply, miss: e.miss }),
      onClose: (r) => {
        closed = r;
      },
    });
    await feed(live, 100);
    assert.deepEqual(texts, [REPROMPT_LINE]);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.detail, 'assistant-empty-reply');
    assert.deepEqual(turns, [{ reply: REPROMPT_LINE, miss: true }]);
    assert.equal(calls.get('CAempty').history.length, 1, 'only the caller turn enters history');
    assert.equal(closed, null, 'the call stays open for the retry');
  });

  it('does not reprompt after a reply whose playback outlasts the turn deadline', async () => {
    const calls = new CallStore();
    const { tts, texts } = stubTts();
    const turns: { reply: string; miss: boolean }[] = [];
    const live = new LiveCallSession({
      identity: { callSid: 'CAlate', streamSid: 'MZlate' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: queueTranscriber(['what are your hours']),
      tts,
      guide: GUIDE,
      availability: AVAILABILITY,
      assistant: {
        reply: async () => ({ text: '', endCall: false }),
        replyStream: async function* () {
          yield 'We are open Monday to Friday. ';
        },
      },
      calls,
      turnDeadlineMs: 30,
      // Playback completes well after the deadline, like a long spoken reply.
      finishPlayback: () =>
        new Promise<PlaybackResult>((resolve) =>
          setTimeout(() => resolve({ outcome: 'played', mark: 'reply-1' }), 60),
        ),
      logTurn: (e) => turns.push({ reply: e.reply, miss: e.miss }),
    });
    await feed(live, 100);
    assert.deepEqual(texts, ['We are open Monday to Friday.']);
    assert.deepEqual(turns, [{ reply: 'We are open Monday to Friday. ', miss: false }]);
  });

  it('does not reprompt when generation completes after the deadline edge', async () => {
    const calls = new CallStore();
    const { tts, texts } = stubTts();
    const turns: { reply: string; miss: boolean }[] = [];
    const live = new LiveCallSession({
      identity: { callSid: 'CAedge', streamSid: 'MZedge' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: queueTranscriber(['what are your hours']),
      tts,
      guide: GUIDE,
      availability: AVAILABILITY,
      assistant: {
        reply: async () => ({ text: '', endCall: false }),
        // The provider finishes just after the deadline fired; the reply is
        // complete, so the Turn must not be treated as missed.
        replyStream: async function* () {
          await new Promise((r) => setTimeout(r, 60));
          yield 'We are open Monday to Friday. ';
        },
      },
      calls,
      turnDeadlineMs: 30,
      finishPlayback: async () => ({ outcome: 'played', mark: 'reply-1' }),
      logTurn: (e) => turns.push({ reply: e.reply, miss: e.miss }),
    });
    await feed(live, 100);
    assert.deepEqual(texts, ['We are open Monday to Friday.']);
    assert.deepEqual(turns, [{ reply: 'We are open Monday to Friday. ', miss: false }]);
  });

  it('closes the TTS session when the call closes', () => {
    const calls = new CallStore();
    let closes = 0;
    const tts: Tts = {
      synthesize: async () => ({ audio: Buffer.from([0xff]) }),
      close: () => {
        closes += 1;
      },
    };
    const live = new LiveCallSession({
      identity: { callSid: 'CAttsclose', streamSid: 'MZttsclose' },
      sendAudio: () => {},
      vad: scriptVad(silence(5)),
      policy: POLICY,
      transcriber: queueTranscriber(['hello']),
      tts,
      guide: GUIDE,
      calls,
    });
    live.close('test');
    assert.equal(closes, 1);
  });

  it('speaks a hold line and logs phases when the assistant is slow', async () => {
    const calls = new CallStore();
    const { tts, texts } = stubTts();
    const phases: Record<string, unknown>[] = [];
    const assistant: Assistant = {
      reply: async () => ({ text: '', endCall: false }),
      replyStream: async function* () {
        await new Promise((r) => setTimeout(r, 60));
        yield 'We are open Monday to Friday. ';
      },
    };
    const live = new LiveCallSession({
      identity: { callSid: 'CA11slow', streamSid: 'MZ11slow' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: queueTranscriber(['what are your hours']),
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
    assert.ok(texts.some((t) => t.includes('Monday to Friday')));
    const names = phases.map((p) => `${String(p.phase)}:${String(p.event)}`);
    assert.ok(names.includes('transcribe:done'));
    assert.ok(names.includes('assistant:hold'));
    assert.ok(names.includes('assistant:first-token'));
    assert.ok(names.includes('tts:done'));
    assert.equal(phases.every((p) => p.kind === 'phase' && p.callSid === 'CA11slow'), true);
  });

  it('prefetches availability at open and serves the first booking turn from it', async () => {
    const calls = new CallStore();
    const { tts } = stubTts();
    const phases: Record<string, unknown>[] = [];
    let reads = 0;
    const assistant: Assistant = {
      reply: async () => ({ text: '', endCall: false }),
      replyStream: async function* (ctx: AssistantContext) {
        assert.equal(ctx.availability, AVAILABILITY, 'the warm block is injected into the prompt');
        assert.equal(await ctx.getAvailability(), AVAILABILITY);
        yield 'Wednesday at ten is free. ';
      },
    };
    const live = new LiveCallSession({
      identity: { callSid: 'CApre', streamSid: 'MZpre' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: queueTranscriber(['book Wednesday morning']),
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
    await live.open();
    assert.equal(reads, 1, 'open warms availability');
    assert.ok(phases.some((p) => p.phase === 'availability' && p.event === 'done' && p.prefetch === true));
    await feed(live, 100);
    assert.equal(reads, 1, 'the first booking turn reuses the prefetched read');
  });

  it('injects warm availability and traces assistant rounds', async () => {
    const calls = new CallStore();
    const { tts } = stubTts();
    const phases: Record<string, unknown>[] = [];
    const seen: AssistantContext[] = [];
    const live = new LiveCallSession({
      identity: { callSid: 'CAwarm', streamSid: 'MZwarm' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: queueTranscriber(['can I book an appointment?']),
      tts,
      guide: GUIDE,
      availability: AVAILABILITY,
      assistant: {
        reply: async () => ({ text: '', endCall: false }),
        replyStream: async function* (ctx: AssistantContext) {
          seen.push(ctx);
          ctx.onAssistantEvent?.({ round: 1, event: 'first-token', ms: 42 });
          ctx.onAssistantEvent?.({ round: 1, event: 'tool-done', name: 'get_availability', ms: 7 });
          yield 'Wednesday at ten is free. ';
        },
      },
      calls,
      logSession: (e) => phases.push(e),
    });
    await live.open();
    await feed(live, 100);
    assert.equal(seen[0]!.availability, AVAILABILITY);
    assert.ok(phases.some((p) => p.phase === 'availability' && p.event === 'injected' && p.turn === 1));
    assert.ok(phases.some((p) => p.phase === 'llm' && p.event === 'first-token' && p.ms === 42 && p.turn === 1));
    assert.ok(phases.some((p) => p.phase === 'llm' && p.event === 'tool-done' && p.tool === 'get_availability'));
  });

  it('traces endpointing stats for each utterance', async () => {
    const calls = new CallStore();
    const { tts } = stubTts();
    const events: TraceEvent[] = [];
    const live = new LiveCallSession({
      identity: { callSid: 'CAtrace', streamSid: 'MZtrace' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: queueTranscriber(['hello']),
      tts,
      guide: GUIDE,
      calls,
      trace: (e) => events.push(e),
    });
    await feed(live, 100);
    const endpoint = events.find((e) => e.component === 'vad' && e.event === 'endpoint')!;
    assert.equal(endpoint['turn'], 1);
    assert.ok(Number(endpoint['speechMs']) > 0);
    assert.ok(Number(endpoint['frames']) > 0);
    assert.equal(endpoint['maxScore'], 0.9);
    assert.equal(endpoint['meanScore'] !== undefined, true);
  });

  it('carries every LLM diagnostic field into the phase trace', async () => {
    const calls = new CallStore();
    const { tts } = stubTts();
    const phases: Record<string, unknown>[] = [];
    const live = new LiveCallSession({
      identity: { callSid: 'CAfields', streamSid: 'MZfields' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: queueTranscriber(['what are your hours']),
      tts,
      guide: GUIDE,
      assistant: {
        reply: async () => ({ text: '', endCall: false }),
        replyStream: async function* (ctx: AssistantContext) {
          ctx.onAssistantEvent?.({
            round: 1,
            event: 'done',
            ms: 900,
            chars: 0,
            finish: 'length',
            reasoningChars: 1200,
            chunks: 3,
            toolCalls: 0,
          });
          yield 'Recovered. ';
        },
      },
      calls,
      logSession: (e) => phases.push(e),
    });
    await feed(live, 100);
    const done = phases.find((p) => p.phase === 'llm' && p.event === 'done')!;
    assert.equal(done['finish'], 'length');
    assert.equal(done['reasoningChars'], 1200);
    assert.equal(done['chunks'], 3);
    assert.equal(done['turn'], 1);
  });

  it('waits for the controller-owned availability read before wording the offer', async () => {
    const calls = new CallStore();
    const { tts } = stubTts();
    const seen: AssistantContext[] = [];
    let release: ((block: string) => void) | null = null;
    const live = new LiveCallSession({
      identity: { callSid: 'CAcold', streamSid: 'MZcold' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: queueTranscriber(['can I book an appointment?']),
      tts,
      guide: GUIDE,
      availability: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
      assistant: {
        reply: async () => ({ text: '', endCall: false }),
        replyStream: async function* (ctx: AssistantContext) {
          seen.push(ctx);
          yield 'Sure. ';
        },
      },
      calls,
    });
    const feeding = feed(live, 100);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(seen.length, 0, 'the model is not consulted before the read lands');
    release!(AVAILABILITY);
    await feeding;
    assert.equal(seen[0]!.availability, AVAILABILITY, 'the controller injects the live block');
    live.close('test');
  });

  it('greets without waiting for the start-of-call availability prefetch', async () => {
    const calls = new CallStore();
    const { tts, texts } = stubTts();
    let release: ((block: string) => void) | null = null;
    let reads = 0;
    const live = new LiveCallSession({
      identity: { callSid: 'CApre2', streamSid: 'MZpre2' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: queueTranscriber(['hello']),
      tts,
      guide: GUIDE,
      availability: () => {
        reads += 1;
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      },
      calls,
    });
    await live.open();
    assert.equal(reads, 1, 'the prefetch is kicked off at open');
    assert.equal(texts[0], greetingFor(GUIDE), 'the greeting is spoken while availability is still loading');
    release!(AVAILABILITY);
    live.close('test');
  });

  it('does not read availability for an assistant reply that never asks for it', async () => {
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

  it('reads each Turn from the live Sarvam session instead of REST', async () => {
    const calls = new CallStore();
    const { tts } = stubTts();
    const events: string[] = [];
    const realtime: RealtimeStt = {
      pushAudio: () => events.push('push'),
      speechStart: () => events.push('start'),
      finalize: async () => {
        events.push('finalize');
        return { text: 'what are your hours', noSpeech: false };
      },
      close: () => events.push('close'),
    };
    let restCalls = 0;
    const transcriber: Transcriber = {
      transcribe: async () => {
        restCalls += 1;
        return { text: 'rest fallback', noSpeech: false };
      },
    };
    const live = new LiveCallSession({
      identity: { callSid: 'CArt', streamSid: 'MZrt' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber,
      realtime,
      tts,
      guide: GUIDE,
      assistant: {
        reply: async () => ({ text: '', endCall: false }),
        replyStream: async function* () {
          yield 'We are open Monday to Friday. ';
        },
      },
      calls,
    });
    await feed(live, 100);
    assert.equal(restCalls, 0, 'live transcript wins over the REST fallback');
    assert.equal(calls.get('CArt').history[0]!.text, 'what are your hours');
    assert.ok(events.includes('finalize'));
    assert.ok(events.filter((e) => e === 'push').length > 0);
    live.close('test');
    assert.ok(events.includes('close'));
  });

  it('stops accepting a second utterance as soon as the first one endpoints', async () => {
    const calls = new CallStore();
    const { tts } = stubTts();
    let releaseFirst!: () => void;
    const firstTranscript = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let transcriptions = 0;
    const live = new LiveCallSession({
      identity: { callSid: 'CAsingleturn', streamSid: 'MZsingleturn' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50), ...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: {
        transcribe: async () => {
          transcriptions += 1;
          if (transcriptions === 1) await firstTranscript;
          return { text: 'hello', noSpeech: false };
        },
      },
      tts,
      guide: GUIDE,
      assistant: {
        reply: async () => ({ text: '', endCall: false }),
        replyStream: async function* () {
          yield 'How can I help? ';
        },
      },
      calls,
    });
    for (let i = 0; i < 100; i += 1) await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
    for (let i = 0; i < 100; i += 1) await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
    releaseFirst();
    await live.flush();
    assert.equal(transcriptions, 1);
    assert.equal(calls.get('CAsingleturn').turn, 1);
  });

  it('opens the live STT utterance for a short latched utterance instead of falling back', async () => {
    const calls = new CallStore();
    const { tts } = stubTts();
    let open = false;
    const events: string[] = [];
    const realtime: RealtimeStt = {
      pushAudio: () => {},
      speechStart: () => {
        open = true;
        events.push('start');
      },
      finalize: async () => {
        if (!open) throw new Error('sarvam-realtime-not-streaming');
        open = false;
        return { text: 'yes', noSpeech: false };
      },
      close: () => {},
    };
    let restCalls = 0;
    const transcriber: Transcriber = {
      transcribe: async () => {
        restCalls += 1;
        return { text: 'rest fallback', noSpeech: false };
      },
    };
    const live = new LiveCallSession({
      identity: { callSid: 'CAshort', streamSid: 'MZshort' },
      sendAudio: () => {},
      vad: scriptVad([...speech(15), ...silence(60)]),
      policy: POLICY,
      transcriber,
      realtime,
      tts,
      guide: GUIDE,
      assistant: {
        reply: async () => ({ text: '', endCall: false }),
        replyStream: async function* () {
          yield 'Yes. ';
        },
      },
      calls,
    });
    await feed(live, 75);
    assert.equal(restCalls, 0, 'the live channel carried the short utterance');
    assert.ok(events.includes('start'));
    assert.equal(calls.get('CAshort').history[0]!.text, 'yes');
    live.close('test');
  });

  it('falls back to REST transcription when the live session fails', async () => {
    const calls = new CallStore();
    const { tts } = stubTts();
    const phases: Record<string, unknown>[] = [];
    const realtime: RealtimeStt = {
      pushAudio: () => {},
      speechStart: () => {},
      finalize: async () => {
        throw new Error('sarvam-realtime-closed');
      },
      close: () => {},
    };
    const live = new LiveCallSession({
      identity: { callSid: 'CAfb', streamSid: 'MZfb' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: queueTranscriber(['rest transcript']),
      realtime,
      tts,
      guide: GUIDE,
      assistant: {
        reply: async () => ({ text: '', endCall: false }),
        replyStream: async function* () {
          yield 'Sure. ';
        },
      },
      calls,
      logSession: (e) => phases.push(e),
    });
    await feed(live, 100);
    assert.equal(calls.get('CAfb').history[0]!.text, 'rest transcript');
    assert.ok(phases.some((p) => p.phase === 'transcribe' && p.event === 'fallback'));
    assert.ok(phases.some((p) => p.phase === 'transcribe' && p.event === 'done' && p.source === 'rest'));
  });

  it('books only after a played readback and a later confirmation turn', async () => {
    const calls = new CallStore();
    const { tts, texts } = stubTts();
    const proposed: { slot: Record<string, string> }[] = [];
    const turns: { reply: string; endCall: boolean }[] = [];
    const live = new LiveCallSession({
      identity: { callSid: 'CA11book', streamSid: 'MZ11book' },
      sendAudio: () => {},
      vad: scriptVad([...speech(50), ...silence(50), ...speech(50), ...silence(50)]),
      policy: POLICY,
      transcriber: queueTranscriber(['book Wednesday at 9:30, my name is Asha, 9840950950', 'yes']),
      tts,
      guide: GUIDE,
      availability: AVAILABILITY,
      calls,
      onProposeBooking: async (args) => {
        proposed.push({ slot: { ...args.slot } });
        return { ok: true };
      },
      logTurn: (e) => turns.push({ reply: e.reply, endCall: e.endCall }),
    });
    await feed(live, 100);
    assert.equal(proposed.length, 0, 'no write before the readback and confirmation');
    const readback = texts.find((t) => t.includes('Asha'));
    assert.ok(readback, 'the readback is spoken deterministically');
    assert.match(readback!, /Shall I book it\?/);
    await feed(live, 100);
    assert.equal(proposed.length, 1);
    assert.equal(proposed[0]!.slot.callerName, 'Asha');
    assert.equal(proposed[0]!.slot.callerPhone, '9840950950');
    assert.ok(texts.some((t) => t.includes('Booked')));
    assert.equal(turns.at(-1)!.endCall, false);
    const history = calls.get('CA11book').history;
    assert.equal(history.filter((h) => h.role === 'receptionist').length, 2, 'the played readback and the booking outcome enter history');
  });
});
