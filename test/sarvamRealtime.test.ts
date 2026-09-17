import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SarvamRealtimeStt,
  type RealtimeSocket,
  type RealtimeSocketFactory,
  type SarvamRealtimeConfig,
} from '../src/sarvamRealtime.ts';
import type { TraceEvent } from '../src/trace.ts';

/** In-memory stand-in for the Sarvam realtime websocket. No network. */
class FakeRealtimeSocket implements RealtimeSocket {
  readonly sent: string[] = [];
  closed = false;
  private openCb: (() => void) | null = null;
  private messageCb: ((data: string) => void) | null = null;
  private closeCb: ((code: number, reason: string) => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

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

  peerError(err: Error): void {
    this.errorCb?.(err);
  }

  peerClose(code = 1000, reason = ''): void {
    this.closeCb?.(code, reason);
  }

  sentJson(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

const CONFIG: SarvamRealtimeConfig = {
  apiKey: 'sk-sarvam',
  baseUrl: 'https://api.sarvam.ai',
  model: 'saaras:v3-realtime',
  languageCode: 'en-IN',
  streamType: 'fast',
  mode: 'transcribe',
  encoding: 'mulaw',
  sampleRate: 8000,
};

function harness(overrides: Partial<SarvamRealtimeConfig> = {}) {
  const socket = new FakeRealtimeSocket();
  let url = '';
  let headers: Record<string, string> = {};
  const connect: RealtimeSocketFactory = (u, h) => {
    url = u;
    headers = h;
    return socket;
  };
  const stt = new SarvamRealtimeStt({ config: { ...CONFIG, ...overrides }, connect });
  return { socket, stt, url: () => url, headers: () => headers };
}

describe('SarvamRealtimeStt', () => {
  it('connects to the realtime endpoint with manual endpointing, mulaw @ 8 kHz and the key', () => {
    const h = harness();
    const url = new URL(h.url());
    assert.equal(url.protocol, 'wss:');
    assert.equal(url.host, 'api.sarvam.ai');
    assert.equal(url.pathname, '/speech-to-text-realtime/ws');
    assert.equal(url.searchParams.get('language_code'), 'en-IN');
    assert.equal(url.searchParams.get('model'), 'saaras:v3-realtime');
    assert.equal(url.searchParams.get('stream_type'), 'fast');
    assert.equal(url.searchParams.get('mode'), 'transcribe');
    assert.equal(url.searchParams.get('endpointing'), 'manual');
    assert.equal(url.searchParams.get('encoding'), 'mulaw');
    assert.equal(url.searchParams.get('sample_rate'), '8000');
    assert.equal(h.headers()['api-subscription-key'], 'sk-sarvam');
    h.stt.close();
  });

  it('buffers audio until speechStart, then flushes it before live chunks', () => {
    const h = harness();
    h.socket.peerOpen();
    h.stt.pushAudio(Buffer.from([1, 2]));
    h.stt.pushAudio(Buffer.from([3]));
    assert.equal(h.socket.sentJson().length, 0, 'pre-speech audio is held back');

    h.stt.speechStart();
    assert.deepEqual(
      h.socket.sentJson().map((m) => m['event']),
      ['speech_start', 'audio_input', 'audio_input'],
    );
    assert.equal(h.socket.sentJson()[1]!['audio'], Buffer.from([1, 2]).toString('base64'));

    h.stt.pushAudio(Buffer.from([4]));
    assert.equal(h.socket.sentJson().at(-1)!['audio'], Buffer.from([4]).toString('base64'));
    h.stt.close();
  });

  it('queues speech_start and buffered audio until the socket opens', () => {
    const h = harness();
    h.stt.pushAudio(Buffer.from([9]));
    h.stt.speechStart();
    assert.equal(h.socket.sent.length, 0, 'nothing before the handshake');
    h.socket.peerOpen();
    assert.deepEqual(
      h.socket.sentJson().map((m) => m['event']),
      ['speech_start', 'audio_input'],
    );
    h.stt.close();
  });

  it('treats a repeated speechStart as the same utterance', () => {
    const h = harness();
    h.socket.peerOpen();
    h.stt.speechStart();
    h.stt.speechStart();
    assert.equal(h.socket.sentJson().filter((m) => m['event'] === 'speech_start').length, 1);
    h.stt.close();
  });

  it('caps pre-speech audio to the recent pre-roll', () => {
    const h = harness({ preRollBytes: 3 });
    h.socket.peerOpen();
    for (const byte of [1, 2, 3, 4, 5]) h.stt.pushAudio(Buffer.from([byte]));
    h.stt.speechStart();
    const frames = h.socket.sentJson().filter((m) => m['event'] === 'audio_input');
    assert.deepEqual(
      frames.map((m) => m['audio']),
      [3, 4, 5].map((b) => Buffer.from([b]).toString('base64')),
    );
    h.stt.close();
  });

  it('resolves finalize with the transcript after speech_end', async () => {
    const h = harness();
    h.socket.peerOpen();
    h.stt.pushAudio(Buffer.from([1]));
    h.stt.speechStart();
    const pending = h.stt.finalize();
    assert.equal(h.socket.sentJson().at(-1)!['event'], 'speech_end');
    h.socket.peerMessage({ event: 'transcript.final', utterance_idx: 0, text: 'book Wednesday' });
    const tx = await pending;
    assert.equal(tx.text, 'book Wednesday');
    assert.equal(tx.noSpeech, false);
    h.stt.close();
  });

  it('flags an empty final as no-speech', async () => {
    const h = harness();
    h.socket.peerOpen();
    h.stt.speechStart();
    const pending = h.stt.finalize();
    h.socket.peerMessage({ event: 'transcript.final', utterance_idx: 0, text: '   ' });
    assert.equal((await pending).noSpeech, true);
    h.stt.close();
  });

  it('rejects finalize that never receives a final', async () => {
    const h = harness({ finalTimeoutMs: 20 });
    h.socket.peerOpen();
    h.stt.speechStart();
    await assert.rejects(() => h.stt.finalize(), /sarvam-realtime-final-timeout/);
    h.stt.close();
  });

  it('discards a timed-out utterance\'s late final instead of feeding the next Turn', async () => {
    const h = harness({ finalTimeoutMs: 20 });
    h.socket.peerOpen();
    h.stt.speechStart();
    await assert.rejects(() => h.stt.finalize(), /sarvam-realtime-final-timeout/);
    h.stt.speechStart();
    const next = h.stt.finalize();
    h.socket.peerMessage({ event: 'transcript.final', utterance_idx: 0, text: 'stale words' });
    h.socket.peerMessage({ event: 'transcript.final', utterance_idx: 1, text: 'fresh words' });
    assert.equal((await next).text, 'fresh words');
    h.stt.close();
  });

  it('accepts the next indexed final when the timed-out final never arrives', async () => {
    const h = harness({ finalTimeoutMs: 20 });
    h.socket.peerOpen();
    h.stt.speechStart();
    await assert.rejects(() => h.stt.finalize(), /sarvam-realtime-final-timeout/);
    h.stt.speechStart();
    const next = h.stt.finalize();
    h.socket.peerMessage({ event: 'transcript.final', utterance_idx: 1, text: 'fresh words' });
    assert.equal((await next).text, 'fresh words');
    h.stt.close();
  });

  it('rejects finalize when the socket fails, so the caller can fall back', async () => {
    const h = harness();
    h.socket.peerOpen();
    h.stt.speechStart();
    const pending = h.stt.finalize();
    h.socket.peerError(new Error('sarvam-realtime-closed'));
    await assert.rejects(() => pending);
    await assert.rejects(() => h.stt.finalize(), /sarvam-realtime/);
    h.stt.close();
  });

  it('rejects finalize before any speech has streamed', async () => {
    const h = harness();
    h.socket.peerOpen();
    await assert.rejects(() => h.stt.finalize(), /sarvam-realtime-not-streaming/);
    h.stt.close();
  });

  it('ends the session on close and rejects an in-flight finalize', async () => {
    const h = harness();
    h.socket.peerOpen();
    h.stt.speechStart();
    const pending = h.stt.finalize();
    h.stt.close();
    await assert.rejects(() => pending, /sarvam-realtime-closed/);
    assert.equal(h.socket.sentJson().at(-1)!['event'], 'end');
    assert.equal(h.socket.closed, true);
  });

  it('traces the socket lifecycle, speech start, partials, and the final', async () => {
    const events: TraceEvent[] = [];
    const socket = new FakeRealtimeSocket();
    const stt = new SarvamRealtimeStt({
      config: CONFIG,
      connect: () => socket,
      onTrace: (e) => events.push(e),
    });
    socket.peerOpen();
    stt.pushAudio(Buffer.from([1, 2]));
    stt.speechStart();
    const pending = stt.finalize();
    socket.peerMessage({ event: 'transcript.partial', text: 'book' });
    socket.peerMessage({ event: 'transcript.final', text: 'book Wednesday' });
    await pending;
    stt.close();
    socket.peerClose(1000, 'normal');
    assert.deepEqual(
      events.map((e) => `${e.component}:${e.event}`),
      ['stt:open', 'stt:speech-start', 'stt:partial', 'stt:final', 'stt:close'],
    );
    assert.equal(events[1]!['bufferedBytes'], 2);
    assert.equal(events[3]!['chars'], 14);
    assert.equal(events[3]!['partials'], 1);
    assert.equal(events[3]!['noSpeech'], false);
  });

  it('traces a finalize timeout so the REST fallback is attributable', async () => {
    const events: TraceEvent[] = [];
    const socket = new FakeRealtimeSocket();
    const stt = new SarvamRealtimeStt({
      config: { ...CONFIG, finalTimeoutMs: 20 },
      connect: () => socket,
      onTrace: (e) => events.push(e),
    });
    socket.peerOpen();
    stt.speechStart();
    await assert.rejects(() => stt.finalize(), /sarvam-realtime-final-timeout/);
    stt.close();
    assert.ok(events.some((e) => e.component === 'stt' && e.event === 'final-timeout' && e.ms === 20));
  });

  it('passes the terminology prompt on the connection and reports its hash', () => {
    const h = harness({ prompt: 'Bobby Clinic, Bobby Hospital, Bob Gowda' });
    const url = new URL(h.url());
    assert.equal(url.searchParams.get('prompt'), 'Bobby Clinic, Bobby Hospital, Bob Gowda');
    h.socket.peerOpen();
    h.stt.close();
  });

  it('updates the prompt mid-call at an utterance boundary', () => {
    const h = harness();
    h.socket.peerOpen();
    h.stt.reconfigure({ prompt: 'Bobby Clinic, Appointment' });
    const update = h.socket.sentJson().at(-1)!;
    assert.equal(update['event'], 'config.update');
    assert.equal(update['prompt'], 'Bobby Clinic, Appointment');
    h.socket.peerMessage({ event: 'config.updated', applied: ['prompt'] });
    h.stt.close();
  });

  it('surfaces partial transcripts for speculation and barge-in', () => {
    const partials: { text: string; utteranceIdx?: number }[] = [];
    const socket = new FakeRealtimeSocket();
    const stt = new SarvamRealtimeStt({
      config: CONFIG,
      connect: () => socket,
      onPartial: (partial) => partials.push({ text: partial.text, utteranceIdx: partial.utteranceIdx }),
    });
    socket.peerOpen();
    socket.peerMessage({ event: 'transcript.partial', utterance_idx: 0, text: 'book Wed' });
    socket.peerMessage({ event: 'transcript.partial', utterance_idx: 0, text: 'book Wednesday' });
    assert.deepEqual(partials, [
      { text: 'book Wed', utteranceIdx: 0 },
      { text: 'book Wednesday', utteranceIdx: 0 },
    ]);
    stt.close();
  });
});
