import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CallStore } from '../src/calls.ts';
import { LiveCallSession } from '../src/live.ts';
import type { Vad } from '../src/endpoint.ts';
import type { Assistant, AssistantContext, BookingOutcome, TurnEvent } from '../src/app.ts';
import type { PartialTranscript, RealtimeStt } from '../src/realtimeStt.ts';
import type { Tts } from '../src/tts.ts';
import type { TraceEvent } from '../src/trace.ts';
import { OpenAiRealtimeStt } from '../src/openaiRealtime.ts';
import type { RealtimeSocket } from '../src/ws.ts';
import type { PlaybackResult } from '../src/transport.ts';
import { FRAME_BYTES, SILENCE_FRAME, SPEECH_FRAME, byteVad } from './fakeStream.ts';

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

/** Scripted realtime channel whose finalize can be held open by the test. */
class FakeSpecStt implements RealtimeStt {
  readonly partials = true;
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
    vad: byteVad,
    policy: POLICY,
    transcriber: { transcribe: async () => ({ text: opts.restText ?? 'rest transcript', noSpeech: false }) },
    realtime: stt,
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

/**
 * One locally-endpointed utterance: speech long enough to latch, the partial
 * under test, then the trailing silence that ends the Turn (the 300 ms
 * adaptive floor, since the partial is complete).
 */
async function speak(h: Harness, partial: string, speechFrames = 20): Promise<void> {
  for (let i = 0; i < speechFrames; i++) await h.live.receiveAudio(SPEECH_FRAME);
  h.stt.partial(partial);
  for (let i = 0; i < 15; i++) await h.live.receiveAudio(SILENCE_FRAME);
}

function speculationEvents(traces: TraceEvent[], event: string): TraceEvent[] {
  return traces.filter((entry) => entry.component === 'call' && entry.event === event);
}

describe('live speculative replies (ticket 09)', () => {
  it('answers before the final lands and keeps the reply when the final agrees', async () => {
    const stt = new FakeSpecStt();
    const { assistant, calls: assistantCalls } = scriptedAssistant(() => 'We are open Monday to Friday.');
    const h = liveSession('CAspec1', { stt, assistant });

    await speak(h, 'what are your hours');

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

  it('traces partial counts and latency, never raw partial text', async () => {
    const stt = new FakeSpecStt();
    const { assistant } = scriptedAssistant(() => 'We are open Monday to Friday.');
    const h = liveSession('CAspec10', { stt, assistant });

    await speak(h, 'what are your hours');
    await waitFor(() => h.texts.length > 0, 'speculative reply audio');
    stt.resolveFinal('what are your hours');
    await h.live.flush();
    await waitFor(() => h.live.currentPhase === 'LISTENING', 'listening after the reply');

    assert.equal(
      JSON.stringify(h.traces).includes('what are your hours'),
      false,
      'raw partial text never reaches traces',
    );
    const started = speculationEvents(h.traces, 'speculation-start');
    assert.equal(started.length, 1);
    assert.equal(started[0]!['chars'], 'what are your hours'.length, 'the start trace carries the partial size');
    const kept = speculationEvents(h.traces, 'speculation-kept');
    assert.equal(kept.length, 1);
    assert.equal(typeof kept[0]!['ms'], 'number', 'the kept trace carries the latency');
    h.live.close('test');
  });

  it('keeps the speculation when the final only extends the partial', async () => {
    const stt = new FakeSpecStt();
    const { assistant, calls: assistantCalls } = scriptedAssistant(() => 'We are open Monday to Friday.');
    const h = liveSession('CAspec2', { stt, assistant });

    await speak(h, 'what are your hours');
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

    await speak(h, 'book me for tomorrow');
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

    await speak(h, 'what are your hours');
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

    await speak(h, 'what are your hours');
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

    await speak(h, 'what are your hours');
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

    for (let i = 0; i < 20; i++) await h.live.receiveAudio(SPEECH_FRAME);
    stt.partial('what are your hours');
    const started = speculationEvents(h.traces, 'speculation-start').length;
    stt.partial('what are your hours tomorrow');
    assert.equal(started, 1);
    const aborted = speculationEvents(h.traces, 'speculation-aborted');
    assert.equal(aborted.length, 1);
    assert.equal(aborted[0]!['reason'], 'booking-cue');

    await feed(h.live, 15);
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

    await speak(h, 'can i ask you something');
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

    await speak(h, 'what are your hours');
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

/** In-memory stand-in for the OpenAI Realtime websocket. No network. */
class FakeProviderSocket implements RealtimeSocket {
  readonly sent: string[] = [];
  private openCb: (() => void) | null = null;
  private messageCb: ((data: string) => void) | null = null;
  private closeCb: ((code: number, reason: string) => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {}

  onOpen(cb: () => void): void {
    this.openCb = cb;
  }

  onMessage(cb: (data: string) => void): void {
    this.messageCb = cb;
  }

  onClose(cb: (code: number, reason: string) => void): void {
    this.closeCb = cb;
  }

  onError(cb: (err: Error) => void): void {
    this.errorCb = cb;
  }

  peerOpen(): void {
    this.openCb?.();
  }

  peerMessage(payload: unknown): void {
    this.messageCb?.(JSON.stringify(payload));
  }

  sentTypes(): string[] {
    return this.sent.map((entry) => (JSON.parse(entry) as { type?: string }).type ?? '');
  }
}

function providerDelta(socket: FakeProviderSocket, itemId: string, delta: string): void {
  socket.peerMessage({ type: 'conversation.item.input_audio_transcription.delta', item_id: itemId, delta });
}

function providerFinal(socket: FakeProviderSocket, itemId: string, transcript: string): void {
  socket.peerMessage({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript,
  });
}

function liveProviderSession(
  callSid: string,
  stt: RealtimeStt,
  assistant: Assistant | undefined,
  opts: {
    finishPlayback?: () => Promise<PlaybackResult>;
    onClear?: () => void;
  } = {},
): Harness {
  const { tts, texts } = stubTts();
  const calls = new CallStore();
  const turns: TurnEvent[] = [];
  const traces: TraceEvent[] = [];
  const clears: string[] = [];
  const proposals = { count: 0 };
  const live = new LiveCallSession({
    identity: { callSid, streamSid: `MZ${callSid}` },
    sendAudio: () => {},
    vad: byteVad,
    policy: POLICY,
    transcriber: { transcribe: async () => ({ text: 'rest transcript', noSpeech: false }) },
    realtime: stt,
    tts,
    guide: GUIDE,
    availability: () => Promise.resolve(AVAILABILITY),
    assistant,
    onProposeBooking: async () => {
      proposals.count += 1;
      return { ok: true } as BookingOutcome;
    },
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
    stt: stt as FakeSpecStt,
    calls,
    texts,
    turns,
    traces,
    clears,
    get proposals() {
      return proposals.count;
    },
    get availabilityReads() {
      return 0;
    },
  };
}

/**
 * One utterance against the real provider channel: Caller speech while the
 * model streams cumulative deltas with lag, then the trailing silence that
 * ends the Turn. The completed event stays withheld until the test sends it,
 * so reply audio that lands first provably beat the final.
 */
async function speakProvider(socket: FakeProviderSocket, h: Harness, deltas: string[]): Promise<void> {
  for (let i = 0; i < 20; i++) await h.live.receiveAudio(SPEECH_FRAME);
  for (const [index, delta] of deltas.entries()) {
    providerDelta(socket, 'item_1', delta);
    if (index < deltas.length - 1) {
      for (let i = 0; i < 2; i++) await h.live.receiveAudio(SPEECH_FRAME);
    }
  }
  for (let i = 0; i < 15; i++) await h.live.receiveAudio(SILENCE_FRAME);
}

describe('live speculative replies against real provider lag (ticket 10)', () => {
  it('answers from cumulative provider partials before the final lands and keeps on agreement', async () => {
    const socket = new FakeProviderSocket();
    const stt = new OpenAiRealtimeStt({
      config: {
        apiKey: 'sk-openai',
        url: 'wss://api.openai.com/v1/realtime?intent=transcription',
        model: 'gpt-live-transcribe',
        delay: 'minimal',
      },
      connect: () => socket,
    });
    socket.peerOpen();
    const { assistant, calls: assistantCalls } = scriptedAssistant(() => 'We are open Monday to Friday.');
    const h = liveProviderSession('CAspecLive1', stt, assistant);

    await speakProvider(socket, h, ['what are', ' your', ' hours']);

    await waitFor(() => h.texts.length > 0, 'reply audio before the final');
    assert.ok(socket.sentTypes().includes('input_audio_buffer.commit'), 'the Turn committed while the final was in flight');
    assert.equal(speculationEvents(h.traces, 'speculation-start').length, 1);
    assert.deepEqual(h.texts, ['We are open Monday to Friday.']);

    providerFinal(socket, 'item_1', 'what are your hours');
    await h.live.flush();
    await waitFor(() => h.live.currentPhase === 'LISTENING', 'listening after the reply');

    assert.equal(assistantCalls.length, 1, 'the agreed speculation is kept, not regenerated');
    assert.equal(assistantCalls[0]!.speculative, true);
    assert.equal(h.clears.length, 0, 'nothing was cancelled');
    assert.equal(h.turns.length, 1);
    assert.equal(h.turns[0]!.excerpt, 'what are your hours');
    assert.equal(h.turns[0]!.reply, 'We are open Monday to Friday.');
    assert.deepEqual(
      h.calls.get('CAspecLive1').history.map((entry) => `${entry.role}:${entry.text}`),
      ['caller:what are your hours', 'receptionist:We are open Monday to Friday.'],
    );
    assert.equal(speculationEvents(h.traces, 'speculation-kept').length, 1);
    assert.equal(
      JSON.stringify(h.traces).includes('what are your hours'),
      false,
      'raw partial text never reaches traces',
    );
    assert.equal(h.proposals, 0, 'no Booking write ran');
    h.live.close('test');
  });

  it('aborts the provider-channel speculation on a mismatched final and regenerates', async () => {
    const socket = new FakeProviderSocket();
    const stt = new OpenAiRealtimeStt({
      config: {
        apiKey: 'sk-openai',
        url: 'wss://api.openai.com/v1/realtime?intent=transcription',
        model: 'gpt-live-transcribe',
        delay: 'minimal',
      },
      connect: () => socket,
    });
    socket.peerOpen();
    const { assistant, calls: assistantCalls } = scriptedAssistant((ctx) =>
      ctx.transcript.includes('located') ? 'We are on Main Street.' : 'We are open Monday to Friday.',
    );
    const barrier = playbackBarrier();
    const h = liveProviderSession('CAspecLive2', stt, assistant, {
      finishPlayback: barrier.finishPlayback,
      onClear: barrier.clear,
    });

    await speakProvider(socket, h, ['what are', ' your', ' hours']);
    await waitFor(() => h.texts.length > 0, 'speculative reply audio');

    providerFinal(socket, 'item_1', 'where is the clinic located');
    await waitFor(() => h.clears.length >= 1, 'the speculative playback is cleared');
    barrier.release();
    await h.live.flush();
    await waitFor(() => h.live.currentPhase === 'LISTENING', 'listening after the regenerated reply');

    assert.equal(assistantCalls.length, 2, 'the mismatch regenerates from the final');
    assert.equal(assistantCalls[1]!.transcript, 'where is the clinic located');
    assert.notEqual(assistantCalls[1]!.speculative, true);
    assert.deepEqual(h.texts, ['We are open Monday to Friday.', 'We are on Main Street.']);
    assert.deepEqual(
      h.calls.get('CAspecLive2').history.map((entry) => `${entry.role}:${entry.text}`),
      ['caller:where is the clinic located', 'receptionist:We are on Main Street.'],
    );
    assert.ok(
      h.calls.get('CAspecLive2').history.every((entry) => !entry.text.includes('Monday to Friday')),
      'no speculative text reaches history',
    );
    assert.equal(h.turns.length, 1);
    assert.equal(h.turns[0]!.reply, 'We are on Main Street.');
    const aborted = speculationEvents(h.traces, 'speculation-aborted');
    assert.equal(aborted.length, 1);
    assert.equal(aborted[0]!['reason'], 'final-mismatch');
    assert.equal(h.proposals, 0, 'no Booking write ran');
    h.live.close('test');
  });

  it('never traces a digit cue from a Caller number fragment', async () => {
    const stt = new FakeSpecStt();
    const { assistant } = scriptedAssistant(() => 'What number was that?');
    const h = liveSession('CAspecLive3', { stt, assistant });

    for (let i = 0; i < 20; i++) await h.live.receiveAudio(SPEECH_FRAME);
    stt.partial('my number is');
    assert.equal(speculationEvents(h.traces, 'speculation-start').length, 1);
    stt.partial('my number is 9876543210');

    const aborted = speculationEvents(h.traces, 'speculation-aborted');
    assert.equal(aborted.length, 1);
    assert.equal(aborted[0]!['reason'], 'booking-cue');
    assert.equal('cue' in aborted[0]!, false, 'a digit cue never reaches the trace');
    assert.equal(
      JSON.stringify(h.traces).includes('9876543210'),
      false,
      'the Caller number fragment never reaches traces',
    );

    await feed(h.live, 15);
    stt.resolveFinal('my number is 9876543210');
    await h.live.flush();
    await waitFor(() => h.live.currentPhase === 'LISTENING', 'listening after the reply');
    assert.equal(h.turns.length, 1);
    assert.equal(
      JSON.stringify(h.traces).includes('9876543210'),
      false,
      'the final digits never reach traces either',
    );
    h.live.close('test');
  });
});
