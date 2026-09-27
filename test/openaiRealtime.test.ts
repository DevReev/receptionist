import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiRealtimeStt, type OpenAiRealtimeConfig } from '../src/openaiRealtime.ts';
import type { TraceEvent } from '../src/trace.ts';
import type { RealtimeSocket, RealtimeSocketFactory } from '../src/ws.ts';

/** In-memory stand-in for the OpenAI Realtime websocket. No network. */
class FakeSocket implements RealtimeSocket {
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

  sentJson(): Record<string, unknown>[] {
    return this.sent.map((entry) => JSON.parse(entry) as Record<string, unknown>);
  }
}

const CONFIG: OpenAiRealtimeConfig = {
  apiKey: 'sk-openai',
  url: 'wss://api.openai.com/v1/realtime?intent=transcription',
  model: 'gpt-live-transcribe',
  delay: 'minimal',
};

function harness(overrides: Partial<OpenAiRealtimeConfig> = {}) {
  const socket = new FakeSocket();
  let url = '';
  let headers: Record<string, string> = {};
  const connect: RealtimeSocketFactory = (u, h) => {
    url = u;
    headers = h;
    return socket;
  };
  const traces: TraceEvent[] = [];
  const stt = new OpenAiRealtimeStt({ config: { ...CONFIG, ...overrides }, connect, onTrace: (event) => traces.push(event) });
  return { socket, stt, traces, url: () => url, headers: () => headers };
}

function appends(socket: FakeSocket): string[] {
  return socket
    .sentJson()
    .filter((message) => message['type'] === 'input_audio_buffer.append')
    .map((message) => String(message['audio']));
}

function appendedBytes(socket: FakeSocket): Buffer {
  return Buffer.concat(appends(socket).map((b64) => Buffer.from(b64, 'base64')));
}

function completions(socket: FakeSocket, transcript: string): void {
  socket.peerMessage({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_1', transcript });
}

function delta(socket: FakeSocket, itemId: string, text: string): void {
  socket.peerMessage({ type: 'conversation.item.input_audio_transcription.delta', item_id: itemId, delta: text });
}

describe('OpenAiRealtimeStt', () => {
  it('connects to the transcription endpoint and configures pcmu with no turn detection', () => {
    const h = harness({ keywords: ['Bobby Clinic', 'Bobby Hospital'], languages: ['en'] });
    assert.equal(h.url(), CONFIG.url);
    assert.equal(h.headers()['Authorization'], 'Bearer sk-openai');
    h.socket.peerOpen();
    const update = h.socket.sentJson()[0]!;
    assert.equal(update['type'], 'session.update');
    const session = update['session'] as {
      type: string;
      audio: { input: { format: unknown; transcription: Record<string, unknown>; turn_detection: unknown } };
    };
    assert.equal(session.type, 'transcription');
    assert.deepEqual(session.audio.input.format, { type: 'audio/pcmu' });
    assert.deepEqual(session.audio.input.transcription, {
      model: 'gpt-live-transcribe',
      delay: 'minimal',
      keywords: ['Bobby Clinic', 'Bobby Hospital'],
      languages: ['en'],
    });
    assert.equal(session.audio.input.turn_detection, null, 'turn detection is unsupported for this model');
  });

  it('holds pre-speech audio and flushes it in order when speech starts', () => {
    const h = harness();
    h.socket.peerOpen();
    h.stt.pushAudio(Buffer.from([1, 2]));
    h.stt.pushAudio(Buffer.from([3]));
    assert.equal(appends(h.socket).length, 0, 'nothing is billed or sent before speech');
    h.stt.speechStart();
    assert.deepEqual(appendedBytes(h.socket), Buffer.from([1, 2, 3]));
    h.stt.pushAudio(Buffer.from([9, 9]));
    assert.deepEqual(appendedBytes(h.socket), Buffer.from([1, 2, 3, 9, 9]));
  });

  it('commits the utterance and resolves the completed transcript', async () => {
    const h = harness();
    h.socket.peerOpen();
    h.stt.pushAudio(Buffer.from([1, 2, 3, 4]));
    h.stt.speechStart();
    const final = h.stt.finalize();
    const commit = h.socket.sentJson().find((message) => message['type'] === 'input_audio_buffer.commit');
    assert.ok(commit, 'finalize commits the buffer');
    h.socket.peerMessage({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item_1', delta: 'What are' });
    h.socket.peerMessage({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item_1', delta: ' your hours?' });
    completions(h.socket, 'What are your hours?');
    assert.deepEqual(await final, { text: 'What are your hours?', noSpeech: false });
  });

  it('resolves the final from a stream of deltas after the commit lands', async () => {
    const h = harness();
    assert.equal(h.stt.partials, true, 'the adapter declares its partial channel');
    h.socket.peerOpen();
    const partials: string[] = [];
    h.stt.onPartial((partial) => partials.push(partial.text));
    h.stt.pushAudio(Buffer.from([1, 2, 3, 4]));
    h.stt.speechStart();
    const final = h.stt.finalize();
    h.socket.peerMessage({ type: 'input_audio_buffer.committed', item_id: 'item_1' });
    delta(h.socket, 'item_1', 'What are');
    delta(h.socket, 'item_1', ' your hours?');
    assert.deepEqual(partials, ['What are', 'What are your hours?'], 'deltas emit cumulative text');
    completions(h.socket, 'What are your hours?');
    assert.deepEqual(await final, { text: 'What are your hours?', noSpeech: false });
    const traced = h.traces.find((event) => event.component === 'stt' && event.event === 'final');
    assert.equal(traced?.['partials'], 2, 'the final trace carries the partial count');
    assert.equal(JSON.stringify(h.traces).includes('What are'), false, 'no raw partial text reaches traces');
  });

  it('emits partials from the live model before the commit event lands', async () => {
    const h = harness();
    h.socket.peerOpen();
    const partials: string[] = [];
    h.stt.onPartial((partial) => partials.push(partial.text));
    h.stt.pushAudio(Buffer.from([1, 2, 3, 4]));
    h.stt.speechStart();
    delta(h.socket, 'item_1', 'What are');
    delta(h.socket, 'item_1', ' your hours?');
    assert.deepEqual(partials, ['What are', 'What are your hours?']);
    const final = h.stt.finalize();
    h.socket.peerMessage({ type: 'input_audio_buffer.committed', item_id: 'item_1' });
    completions(h.socket, 'What are your hours?');
    assert.deepEqual(await final, { text: 'What are your hours?', noSpeech: false });
  });

  it('never lets a finished item leak deltas into the next utterance', async () => {
    const h = harness();
    h.socket.peerOpen();
    const partials: string[] = [];
    h.stt.onPartial((partial) => partials.push(partial.text));
    h.stt.pushAudio(Buffer.from([1, 2]));
    h.stt.speechStart();
    const first = h.stt.finalize();
    h.socket.peerMessage({ type: 'input_audio_buffer.committed', item_id: 'item_1' });
    delta(h.socket, 'item_1', 'what are');
    delta(h.socket, 'item_1', ' your hours?');
    completions(h.socket, 'what are your hours?');
    assert.deepEqual(await first, { text: 'what are your hours?', noSpeech: false });

    // The next utterance: late deltas from the finished item are dropped, and
    // only the new item's deltas emit.
    h.stt.pushAudio(Buffer.from([3, 4]));
    h.stt.speechStart();
    const second = h.stt.finalize();
    h.socket.peerMessage({ type: 'input_audio_buffer.committed', item_id: 'item_2' });
    delta(h.socket, 'item_1', ' STALE');
    delta(h.socket, 'item_2', 'book ');
    delta(h.socket, 'item_1', ' STALE AGAIN');
    delta(h.socket, 'item_2', 'Wednesday');
    assert.deepEqual(partials, ['what are', 'what are your hours?', 'book ', 'book Wednesday']);
    completions(h.socket, 'book Wednesday');
    assert.deepEqual(await second, { text: 'book Wednesday', noSpeech: false });
  });

  it('drops deltas for an item whose final already landed', () => {
    const h = harness();
    h.socket.peerOpen();
    const partials: string[] = [];
    h.stt.onPartial((partial) => partials.push(partial.text));
    h.stt.speechStart();
    h.stt.pushAudio(Buffer.from([1]));
    delta(h.socket, 'item_1', 'hello');
    completions(h.socket, 'hello');
    delta(h.socket, 'item_1', ' again');
    assert.deepEqual(partials, ['hello'], 'a finished item never emits again');
  });

  it('rejects without committing when the utterance held no audio', async () => {
    const h = harness();
    h.socket.peerOpen();
    await assert.rejects(() => h.stt.finalize(), /openai-realtime-not-streaming/);
    assert.equal(
      h.socket.sentJson().some((message) => message['type'] === 'input_audio_buffer.commit'),
      false,
    );
  });

  it('rejects when the completed event never arrives', async () => {
    const h = harness({ finalTimeoutMs: 25 });
    h.socket.peerOpen();
    h.stt.speechStart();
    h.stt.pushAudio(Buffer.from([1]));
    await assert.rejects(() => h.stt.finalize(), /openai-realtime-final-timeout/);
  });

  it('rejects a pending finalize on a provider error event', async () => {
    const h = harness();
    h.socket.peerOpen();
    h.stt.speechStart();
    h.stt.pushAudio(Buffer.from([1]));
    const final = h.stt.finalize();
    h.socket.peerMessage({ type: 'error', error: { code: 'invalid_request_error', message: 'boom' } });
    await assert.rejects(() => final, /boom/);
    assert.ok(h.traces.some((event) => event.component === 'stt' && event.event === 'error' && event.detail === 'boom'));
  });

  it('traces the appended audio duration on close', () => {
    const h = harness();
    h.socket.peerOpen();
    h.stt.speechStart();
    h.stt.pushAudio(Buffer.alloc(800, 0xff));
    h.stt.close();
    const closed = h.traces.find((event) => event.component === 'stt' && event.event === 'close');
    assert.ok(closed, 'close is traced');
    assert.equal(closed['bytes'], 800);
    assert.equal(closed['audioMs'], 100);
  });
});
