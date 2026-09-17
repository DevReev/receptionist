import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CallStore } from '../src/calls.ts';
import { LiveCallSession } from '../src/live.ts';
import type { Vad } from '../src/endpoint.ts';
import type { Assistant, AssistantContext, BookingOutcome, TurnEvent } from '../src/app.ts';
import type { PartialTranscript, RealtimeEndpointing, RealtimeStt, VadEvent } from '../src/sarvamRealtime.ts';
import type { Tts } from '../src/tts.ts';
import type { TraceEvent } from '../src/trace.ts';
import type { PlaybackResult } from '../src/transport.ts';

const FRAME_BYTES = 160; // 20 ms of 8 kHz mulaw.
const POLICY = { silenceMs: 700, minSpeechMs: 300, maxUtteranceMs: 30000, threshold: 0.5, latchDipMs: 200 };
const GUIDE = {
  raw: [
    '# Clinic Guide — Maple Clinic',
    '',
    '## Locations',
    '',
    '- **Bobby Clinic** — the main venue.',
    '',
    '## Services and fees',
    '',
    '- **Appointment** — 15 minutes — Rs 700.',
    '',
    '## Doctor',
    '',
    '- **Bob Gowda** is the only doctor returned.',
  ].join('\n'),
  name: 'Maple Clinic',
};
const AVAILABILITY =
  'AVAILABILITY (fetched live — only these slots exist)\n- 2026-09-30 09:30 Appointment with Bob Gowda at Bobby Clinic';

/** The provider owns boundaries in this suite; the local VAD never latches. */
const silentVad: Vad = { score: async () => 0.05, reset: () => {} };

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function stubTts(): { tts: Tts; texts: string[] } {
  const texts: string[] = [];
  const tts: Tts = {
    synthesize: async (text: string) => {
      texts.push(text);
      return { audio: Buffer.from([0xff]) };
    },
  };
  return { tts, texts };
}

function scriptedAssistant(replyFor: (ctx: AssistantContext) => string): {
  assistant: Assistant;
  calls: AssistantContext[];
} {
  const calls: AssistantContext[] = [];
  const assistant: Assistant = {
    reply: async () => ({ text: '', endCall: false }),
    replyStream: async function* (ctx: AssistantContext) {
      calls.push(ctx);
      yield replyFor(ctx);
    },
  };
  return { assistant, calls };
}

/** Scripted provider VAD channel whose finalize can be held open by the test. */
class FakeSpecStt implements RealtimeStt {
  endpointing: RealtimeEndpointing = 'vad';
  private handler: ((event: VadEvent) => void) | null = null;
  private partialHandler: ((partial: PartialTranscript) => void) | null = null;
  private pending: ((tx: { text: string; noSpeech: boolean }) => void) | null = null;
  private readonly finals: { text: string; noSpeech: boolean }[];

  constructor(finals: { text: string; noSpeech: boolean }[] = []) {
    this.finals = finals;
  }

  pushAudio(): void {}

  speechStart(): void {}

  finalize(): Promise<{ text: string; noSpeech: boolean }> {
    const scripted = this.finals.shift();
    if (scripted) return Promise.resolve(scripted);
    return new Promise((resolve) => {
      this.pending = resolve;
    });
  }

  get finalPending(): boolean {
    return this.pending !== null;
  }

  resolveFinal(text: string): void {
    const pending = this.pending;
    this.pending = null;
    pending?.({ text, noSpeech: text.trim().length === 0 });
  }

  onVadEvent(handler: (event: VadEvent) => void): void {
    this.handler = handler;
  }

  emit(event: VadEvent): void {
    this.handler?.(event);
  }

  onPartial(handler: (partial: PartialTranscript) => void): void {
    this.partialHandler = handler;
  }

  partial(text: string): void {
    this.partialHandler?.({ text });
  }

  close(): void {}
}

interface Harness {
  live: LiveCallSession;
  stt: FakeSpecStt;
  calls: CallStore;
  texts: string[];
  turns: TurnEvent[];
  traces: TraceEvent[];
  clears: string[];
  proposals: number;
  availabilityReads: number;
}

/** Playback barrier the test releases or clears, like the transport does. */
function playbackBarrier(): {
  finishPlayback: () => Promise<PlaybackResult>;
  release: () => void;
  clear: () => void;
} {
  const waiting: ((result: PlaybackResult) => void)[] = [];
  return {
    finishPlayback: () => new Promise<PlaybackResult>((resolve) => waiting.push(resolve)),
    release: (): void => {
      for (const resolve of waiting.splice(0)) resolve({ outcome: 'played', mark: '' });
    },
    clear: (): void => {
      for (const resolve of waiting.splice(0)) resolve({ outcome: 'cleared', mark: '', reason: 'cleared' });
    },
  };
}

function liveSession(
  callSid: string,
  opts: {
    stt?: FakeSpecStt;
    assistant?: Assistant;
    speculation?: boolean;
    availability?: string | (() => string | Promise<string>);
    onProposeBooking?: () => Promise<BookingOutcome>;
    finishPlayback?: () => Promise<PlaybackResult>;
    onClear?: () => void;
    restText?: string;
  } = {},
): Harness {
  const stt = opts.stt ?? new FakeSpecStt();
  const { tts, texts } = stubTts();
  const calls = new CallStore();
  const turns: TurnEvent[] = [];
  const traces: TraceEvent[] = [];
  const clears: string[] = [];
  const state = { proposals: 0, availabilityReads: 0 };
  const availability = opts.availability;
  const live = new LiveCallSession({
    identity: { callSid, streamSid: `MZ${callSid}` },
    sendAudio: () => {},
    vad: silentVad,
    policy: POLICY,
    transcriber: { transcribe: async () => ({ text: opts.restText ?? 'rest transcript', noSpeech: false }) },
    realtime: stt,
    turnDetection: 'sarvam',
    speculation: opts.speculation,
    tts,
    guide: GUIDE,
    availability:
      typeof availability === 'function'
        ? () => {
            state.availabilityReads += 1;
            return availability();
          }
        : () => {
            state.availabilityReads += 1;
            return Promise.resolve(availability ?? AVAILABILITY);
          },
    assistant: opts.assistant,
    onProposeBooking:
      opts.onProposeBooking ??
      (async () => {
        state.proposals += 1;
        return { ok: true } as BookingOutcome;
      }),
    calls,
    logTurn: (e) => turns.push(e),
    trace: (e) => traces.push(e),
    finishPlayback: opts.finishPlayback,
    clearPlayback: (reason) => {
      clears.push(reason);
      opts.onClear?.();
    },
  });
  return {
    live,
    stt,
    calls,
    texts,
    turns,
    traces,
    clears,
    get proposals() {
      return state.proposals;
    },
    get availabilityReads() {
      return state.availabilityReads;
    },
  };
}

async function feed(live: LiveCallSession, frames: number): Promise<void> {
  for (let i = 0; i < frames; i++) {
    await live.receiveAudio(Buffer.alloc(FRAME_BYTES, 0xff));
  }
}

function speculationEvents(traces: TraceEvent[], event: string): TraceEvent[] {
  return traces.filter((entry) => entry.component === 'call' && entry.event === event);
}

describe('live speculative replies (ticket 09)', () => {
  it('answers before the final lands and keeps the reply when the final agrees', async () => {
    const stt = new FakeSpecStt();
    const { assistant, calls: assistantCalls } = scriptedAssistant(() => 'We are open Monday to Friday.');
    const h = liveSession('CAspec1', { stt, assistant });

    stt.emit('speech_start');
    await feed(h.live, 20);
    stt.partial('what are your hours');
    stt.emit('speech_end');
    await feed(h.live, 1);

    await waitFor(() => h.texts.length > 0, 'reply audio before the final');
    assert.equal(stt.finalPending, true, 'the reply started while the final was still in flight');
    assert.deepEqual(h.texts, ['We are open Monday to Friday.']);
    assert.equal(speculationEvents(h.traces, 'speculation-start').length, 1);

    stt.resolveFinal('what are your hours');
    await h.live.flush();
    await waitFor(() => h.live.currentPhase === 'LISTENING', 'listening after the reply');

    assert.equal(assistantCalls.length, 1, 'the agreed speculation is kept, not regenerated');
    assert.equal(assistantCalls[0]!.speculative, true);
    assert.equal(h.clears.length, 0, 'nothing was cancelled');
    assert.equal(h.turns.length, 1);
    assert.equal(h.turns[0]!.excerpt, 'what are your hours');
    assert.equal(h.turns[0]!.reply, 'We are open Monday to Friday.');
    const history = h.calls.get('CAspec1').history;
    assert.deepEqual(
      history.map((entry) => `${entry.role}:${entry.text}`),
      ['caller:what are your hours', 'receptionist:We are open Monday to Friday.'],
    );
    assert.equal(speculationEvents(h.traces, 'speculation-kept').length, 1);
    h.live.close('test');
  });

  it('keeps the speculation when the final only extends the partial', async () => {
    const stt = new FakeSpecStt();
    const { assistant, calls: assistantCalls } = scriptedAssistant(() => 'We are open Monday to Friday.');
    const h = liveSession('CAspec2', { stt, assistant });

    stt.emit('speech_start');
    await feed(h.live, 20);
    stt.partial('what are your hours');
    stt.emit('speech_end');
    await feed(h.live, 1);
    stt.resolveFinal('what are your hours please');
    await h.live.flush();
    await waitFor(() => h.live.currentPhase === 'LISTENING', 'listening after the reply');

    assert.equal(assistantCalls.length, 1, 'an extended final still agrees');
    assert.equal(h.clears.length, 0);
    assert.equal(h.calls.get('CAspec2').history[0]!.text, 'what are your hours please');
    assert.equal(speculationEvents(h.traces, 'speculation-kept').length, 1);
    h.live.close('test');
  });

  it('does not speculate on a booking-cue partial', async () => {
    const stt = new FakeSpecStt();
    const { assistant, calls: assistantCalls } = scriptedAssistant(() => 'What time would you like?');
    const h = liveSession('CAspec3', { stt, assistant });

    stt.emit('speech_start');
    await feed(h.live, 20);
    stt.partial('book me for tomorrow');
    stt.emit('speech_end');
    await feed(h.live, 1);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(h.texts.length, 0, 'no reply before the final');
    assert.equal(assistantCalls.length, 0, 'no generation from the cue partial');
    assert.equal(speculationEvents(h.traces, 'speculation-start').length, 0);

    stt.resolveFinal('book me for tomorrow');
    await h.live.flush();
    await waitFor(() => h.live.currentPhase === 'LISTENING', 'listening after the reply');
    assert.equal(assistantCalls.length, 1);
    assert.notEqual(assistantCalls[0]!.speculative, true);
    assert.equal(assistantCalls[0]!.transcript, 'book me for tomorrow');
    h.live.close('test');
  });

  it('aborts a mismatched speculation and regenerates from the final', async () => {
    const stt = new FakeSpecStt();
    const { assistant, calls: assistantCalls } = scriptedAssistant((ctx) =>
      ctx.transcript.includes('located') ? 'We are on Main Street.' : 'We are open Monday to Friday.',
    );
    const barrier = playbackBarrier();
    const h = liveSession('CAspec4', {
      stt,
      assistant,
      finishPlayback: barrier.finishPlayback,
      onClear: barrier.clear,
    });

    stt.emit('speech_start');
    await feed(h.live, 20);
    stt.partial('what are your hours');
    stt.emit('speech_end');
    await feed(h.live, 1);
    await waitFor(() => h.texts.length > 0, 'speculative reply audio');
    assert.equal(h.clears.length, 0, 'the speculative playback is still running');

    stt.resolveFinal('where is the clinic located');
    await waitFor(() => h.clears.length >= 1, 'the speculative playback is cleared');
    barrier.release();
    await h.live.flush();
    await waitFor(() => h.live.currentPhase === 'LISTENING', 'listening after the regenerated reply');

    assert.equal(assistantCalls.length, 2, 'the mismatch regenerates from the final');
    assert.equal(assistantCalls[1]!.transcript, 'where is the clinic located');
    assert.notEqual(assistantCalls[1]!.speculative, true);
    assert.deepEqual(h.texts, ['We are open Monday to Friday.', 'We are on Main Street.']);
    assert.ok(h.clears.length >= 1, 'the speculative playback is cleared');
    const history = h.calls.get('CAspec4').history;
    assert.deepEqual(
      history.map((entry) => `${entry.role}:${entry.text}`),
      ['caller:where is the clinic located', 'receptionist:We are on Main Street.'],
    );
    assert.ok(
      history.every((entry) => !entry.text.includes('Monday to Friday')),
      'no speculative text reaches history',
    );
    assert.equal(h.turns.length, 1);
    assert.equal(h.turns[0]!.reply, 'We are on Main Street.');
    const aborted = speculationEvents(h.traces, 'speculation-aborted');
    assert.equal(aborted.length, 1);
    assert.equal(aborted[0]!['reason'], 'final-mismatch');
    h.live.close('test');
  });

  it('never proposes or reads during speculation, even when the final disagrees', async () => {
    const stt = new FakeSpecStt();
    const outcomes: BookingOutcome[] = [];
    const assistant: Assistant = {
      reply: async () => ({ text: '', endCall: false }),
      replyStream: async function* (ctx: AssistantContext) {
        if (ctx.speculative) {
          outcomes.push(
            await ctx.proposeBooking({
              service: 'Appointment',
              location: 'Bobby Clinic',
              date: '2026-09-30',
              time: '09:30',
              callerName: 'Asha',
              callerPhone: '+911234567890',
            }),
          );
          await ctx.getAvailability();
        }
        yield 'We are open Monday to Friday.';
      },
    };
    const h = liveSession('CAspec5', { stt, assistant });

    stt.emit('speech_start');
    await feed(h.live, 20);
    stt.partial('what are your hours');
    stt.emit('speech_end');
    await feed(h.live, 1);
    await waitFor(() => outcomes.length > 0, 'the speculative tool attempts');
    stt.resolveFinal('where is the clinic located');
    await h.live.flush();
    await waitFor(() => h.live.currentPhase === 'LISTENING', 'listening after the regenerated reply');

    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.ok, false, 'the speculative proposal is refused');
    assert.equal(h.proposals, 0, 'no Booking write ran');
    assert.equal(h.availabilityReads, 0, 'no availability read ran');
    h.live.close('test');
  });

  it('removes speculation when the operator turns it off', async () => {
    const stt = new FakeSpecStt();
    const { assistant, calls: assistantCalls } = scriptedAssistant(() => 'We are open Monday to Friday.');
    const h = liveSession('CAspec6', { stt, assistant, speculation: false });

    stt.emit('speech_start');
    await feed(h.live, 20);
    stt.partial('what are your hours');
    stt.emit('speech_end');
    await feed(h.live, 1);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(h.texts.length, 0, 'the no-speculation path waits for the final');
    assert.equal(assistantCalls.length, 0);
    assert.equal(speculationEvents(h.traces, 'speculation-start').length, 0);

    stt.resolveFinal('what are your hours');
    await h.live.flush();
    await waitFor(() => h.live.currentPhase === 'LISTENING', 'listening after the reply');
    assert.equal(assistantCalls.length, 1);
    assert.equal(h.turns.length, 1);
    h.live.close('test');
  });

  it('aborts a pending speculation when a later partial becomes booking-sensitive', async () => {
    const stt = new FakeSpecStt();
    const gate = new Promise<void>((resolve) => setTimeout(resolve, 30));
    const assistant: Assistant = {
      reply: async () => ({ text: '', endCall: false }),
      replyStream: async function* (ctx: AssistantContext) {
        if (ctx.speculative) await gate;
        yield 'We are open Monday to Friday.';
      },
    };
    const h = liveSession('CAspec7', { stt, assistant });

    stt.emit('speech_start');
    await feed(h.live, 10);
    stt.partial('what are your hours');
    const started = speculationEvents(h.traces, 'speculation-start').length;
    stt.partial('what are your hours tomorrow');
    assert.equal(started, 1);
    const aborted = speculationEvents(h.traces, 'speculation-aborted');
    assert.equal(aborted.length, 1);
    assert.equal(aborted[0]!['reason'], 'booking-cue');

    stt.emit('speech_end');
    await feed(h.live, 1);
    stt.resolveFinal('what are your hours tomorrow');
    await h.live.flush();
    await waitFor(() => h.live.currentPhase === 'LISTENING', 'listening after the reply');
    assert.equal(h.turns.length, 1);
    h.live.close('test');
  });

  it('aborts the speculation when the final itself turns booking-sensitive', async () => {
    const stt = new FakeSpecStt();
    const { assistant, calls: assistantCalls } = scriptedAssistant((ctx) =>
      ctx.transcript.includes('reschedule') ? 'What should I change?' : 'We are open Monday to Friday.',
    );
    const h = liveSession('CAspec9', { stt, assistant });

    stt.emit('speech_start');
    await feed(h.live, 20);
    stt.partial('can i ask you something');
    stt.emit('speech_end');
    await feed(h.live, 1);
    await waitFor(() => h.texts.length > 0, 'speculative reply audio');

    stt.resolveFinal('can i ask you something to reschedule');
    await h.live.flush();
    await waitFor(() => h.live.currentPhase === 'LISTENING', 'listening after the regenerated reply');

    assert.equal(assistantCalls.length, 2, 'a booking-sensitive final never keeps the speculation');
    const aborted = speculationEvents(h.traces, 'speculation-aborted');
    assert.equal(aborted.length, 1);
    assert.equal(aborted[0]!['reason'], 'booking-final');
    assert.equal(aborted[0]!['cue'], 'reschedule');
    const history = h.calls.get('CAspec9').history;
    assert.deepEqual(
      history.map((entry) => `${entry.role}:${entry.text}`),
      ['caller:can i ask you something to reschedule', 'receptionist:What should I change?'],
    );
    h.live.close('test');
  });

  it('aborts the speculation and reprompts when the final is empty', async () => {
    const stt = new FakeSpecStt();
    const { assistant } = scriptedAssistant(() => 'We are open Monday to Friday.');
    const barrier = playbackBarrier();
    const h = liveSession('CAspec8', {
      stt,
      assistant,
      finishPlayback: barrier.finishPlayback,
      onClear: barrier.clear,
      restText: '',
    });

    stt.emit('speech_start');
    await feed(h.live, 20);
    stt.partial('what are your hours');
    stt.emit('speech_end');
    await feed(h.live, 1);
    await waitFor(() => h.texts.length > 0, 'speculative reply audio');

    stt.resolveFinal('');
    await waitFor(() => h.clears.length >= 1, 'the speculative playback is cleared');
    barrier.release();
    await h.live.flush();
    await waitFor(() => h.live.currentPhase === 'LISTENING', 'listening after the reprompt');

    assert.ok(h.texts.some((text) => text.includes("didn't catch")), 'the Caller is reprompted');
    assert.equal(h.calls.get('CAspec8').history.length, 0, 'nothing from an empty final reaches history');
    const aborted = speculationEvents(h.traces, 'speculation-aborted');
    assert.equal(aborted.length, 1);
    assert.equal(aborted[0]!['reason'], 'empty-final');
    h.live.close('test');
  });
});
