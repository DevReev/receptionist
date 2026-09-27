import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SarvamStreamingTts, type SarvamStreamTtsConfig } from '../src/sarvamStreamTts.ts';
import type { TraceEvent } from '../src/trace.ts';
import type { Tts } from '../src/tts.ts';
import type { RealtimeSocket, RealtimeSocketFactory } from '../src/ws.ts';

/** In-memory stand-in for the Sarvam TTS websocket. No network. */
class FakeStreamSocket implements RealtimeSocket {
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
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

const CONFIG: SarvamStreamTtsConfig = {
  apiKey: 'sk-sarvam',
  baseUrl: 'https://api.sarvam.ai',
  model: 'bulbul:v3',
  speaker: 'shubh',
  languageCode: 'en-IN',
};

function harness(overrides: Partial<SarvamStreamTtsConfig> = {}, fallback?: Tts) {
  const socket = new FakeStreamSocket();
  let url = '';
  let headers: Record<string, string> = {};
  const connect: RealtimeSocketFactory = (u, h) => {
    url = u;
    headers = h;
    return socket;
  };
  const tts = new SarvamStreamingTts({ config: { ...CONFIG, ...overrides }, fallback, connect });
  return { socket, tts, url: () => url, headers: () => headers };
}

/** Factory that hands out a fresh socket per connection, for reconnect tests. */
function harnessMulti(overrides: Partial<SarvamStreamTtsConfig> = {}) {
  const sockets: FakeStreamSocket[] = [];
  const connect: RealtimeSocketFactory = () => {
    const socket = new FakeStreamSocket();
    sockets.push(socket);
    return socket;
  };
  const tts = new SarvamStreamingTts({ config: { ...CONFIG, ...overrides }, connect });
  return { sockets, tts, socket: () => sockets[sockets.length - 1]! };
}

function collect(stream: AsyncIterable<Buffer>): { chunks: Buffer[]; done: Promise<Buffer[]> } {
  const chunks: Buffer[] = [];
  const done = (async () => {
    for await (const chunk of stream) chunks.push(chunk);
    return chunks;
  })();
  return { chunks, done };
}

function audioMessage(bytes: number[]): Record<string, unknown> {
  return { type: 'audio', data: { content_type: 'audio/mulaw', audio: Buffer.from(bytes).toString('base64') } };
}

const FINAL = { type: 'event', data: { event_type: 'final' } };

describe('SarvamStreamingTts', () => {
  it('connects to the TTS websocket with the key and configures mu-law @ 8 kHz', () => {
    const h = harness();
    const url = new URL(h.url());
    assert.equal(url.protocol, 'wss:');
    assert.equal(url.host, 'api.sarvam.ai');
    assert.equal(url.pathname, '/text-to-speech/ws');
    assert.equal(url.searchParams.get('model'), 'bulbul:v3');
    assert.equal(url.searchParams.get('send_completion_event'), 'true');
    assert.equal(h.headers()['api-subscription-key'], 'sk-sarvam');
    h.socket.peerOpen();
    const config = h.socket.sentJson()[0]!;
    assert.equal(config['type'], 'config');
    assert.deepEqual(config['data'], {
      model: 'bulbul:v3',
      language_code: 'en-IN',
      speaker: 'shubh',
      speech_sample_rate: 8000,
      output_audio_codec: 'mulaw',
    });
    h.tts.close();
  });

  it('streams chunks in order and ends the utterance on the final event', async () => {
    const h = harness();
    h.socket.peerOpen();
    const first = collect(h.tts.synthesizeStream('Welcome to the clinic.'));
    assert.deepEqual(
      h.socket.sentJson().map((m) => m['type']),
      ['config', 'text', 'flush'],
    );
    assert.deepEqual(h.socket.sentJson()[1]!['data'], { text: 'Welcome to the clinic.' });
    h.socket.peerMessage(audioMessage([1, 2]));
    h.socket.peerMessage(audioMessage([3]));
    h.socket.peerMessage(FINAL);
    assert.deepEqual(await first.done, [Buffer.from([1, 2]), Buffer.from([3])]);
    h.tts.close();
  });

  it('serves several utterances in sequence on one socket', async () => {
    const h = harness();
    h.socket.peerOpen();
    const first = collect(h.tts.synthesizeStream('First.'));
    h.socket.peerMessage(audioMessage([1]));
    h.socket.peerMessage(FINAL);
    assert.deepEqual(await first.done, [Buffer.from([1])]);
    const second = collect(h.tts.synthesizeStream('Second.'));
    h.socket.peerMessage(audioMessage([2]));
    h.socket.peerMessage(FINAL);
    assert.deepEqual(await second.done, [Buffer.from([2])]);
    assert.deepEqual(
      h.socket.sentJson().map((m) => m['type']),
      ['config', 'text', 'flush', 'text', 'flush'],
    );
    assert.equal(h.socket.closed, false);
    h.tts.close();
  });

  it('queues text until the socket handshake completes', async () => {
    const h = harness();
    const first = collect(h.tts.synthesizeStream('Hello.'));
    assert.equal(h.socket.sent.length, 0, 'nothing before the handshake');
    h.socket.peerOpen();
    assert.deepEqual(
      h.socket.sentJson().map((m) => m['type']),
      ['config', 'text', 'flush'],
    );
    h.socket.peerMessage(FINAL);
    assert.deepEqual(await first.done, []);
    h.tts.close();
  });

  it('drops late audio after a final instead of leaking it into the next utterance', async () => {
    const h = harness();
    h.socket.peerOpen();
    const first = collect(h.tts.synthesizeStream('First.'));
    h.socket.peerMessage(audioMessage([1]));
    h.socket.peerMessage(FINAL);
    h.socket.peerMessage(audioMessage([99]));
    assert.deepEqual(await first.done, [Buffer.from([1])]);
    const second = collect(h.tts.synthesizeStream('Second.'));
    h.socket.peerMessage(audioMessage([2]));
    h.socket.peerMessage(FINAL);
    assert.deepEqual(await second.done, [Buffer.from([2])]);
    h.tts.close();
  });

  it('fails the utterance on a server error but keeps the socket usable', async () => {
    const h = harness();
    h.socket.peerOpen();
    const first = collect(h.tts.synthesizeStream('Boom.'));
    h.socket.peerMessage({ type: 'error', data: { message: 'bad request', code: 400 } });
    await assert.rejects(() => first.done, /sarvam-tts-stream-error-400/);
    const second = collect(h.tts.synthesizeStream('Again.'));
    h.socket.peerMessage(audioMessage([7]));
    h.socket.peerMessage(FINAL);
    assert.deepEqual(await second.done, [Buffer.from([7])]);
    h.tts.close();
  });

  it('rejects in-flight and future utterances after the socket fails', async () => {
    const h = harness();
    h.socket.peerOpen();
    const first = collect(h.tts.synthesizeStream('Gone.'));
    h.socket.peerError(new Error('socket down'));
    await assert.rejects(() => first.done, /socket down/);
    await assert.rejects(async () => {
      for await (const _chunk of h.tts.synthesizeStream('Later.')) {
        // no audio expected
      }
    }, /sarvam-tts-stream-unavailable/);
  });

  it('times out an idle utterance and stops streaming for the call', async () => {
    const h = harness({ idleTimeoutMs: 20 });
    h.socket.peerOpen();
    const first = collect(h.tts.synthesizeStream('Silence.'));
    await assert.rejects(() => first.done, /sarvam-tts-stream-timeout/);
    await assert.rejects(async () => {
      for await (const _chunk of h.tts.synthesizeStream('Later.')) {
        // no audio expected
      }
    }, /sarvam-tts-stream-unavailable/);
  });

  it('close rejects the in-flight utterance and closes the socket', async () => {
    const h = harness();
    h.socket.peerOpen();
    const first = collect(h.tts.synthesizeStream('Bye.'));
    h.tts.close();
    await assert.rejects(() => first.done, /sarvam-tts-stream-closed/);
    assert.equal(h.socket.closed, true);
    await assert.rejects(async () => {
      for await (const _chunk of h.tts.synthesizeStream('No.')) {
        // no audio expected
      }
    }, /sarvam-tts-stream-unavailable/);
  });

  it('delegates synthesize to the REST fallback', async () => {
    const seen: string[] = [];
    const fallback: Tts = {
      synthesize: async (text: string) => {
        seen.push(text);
        return { audio: Buffer.from([0xaa]) };
      },
    };
    const h = harness({}, fallback);
    const out = await h.tts.synthesize('Hello.');
    assert.deepEqual(seen, ['Hello.']);
    assert.deepEqual(out.audio, Buffer.from([0xaa]));
    h.tts.close();
  });

  it('traces the utterance stream with first-audio latency and chunk volume', async () => {
    const events: TraceEvent[] = [];
    const socket = new FakeStreamSocket();
    const tts = new SarvamStreamingTts({
      config: CONFIG,
      connect: () => socket,
      onTrace: (e) => events.push(e),
    });
    socket.peerOpen();
    const first = collect(tts.synthesizeStream('Welcome.'));
    socket.peerMessage(audioMessage([1, 2]));
    socket.peerMessage(audioMessage([3]));
    socket.peerMessage(FINAL);
    await first.done;
    tts.close();
    assert.deepEqual(
      events.map((e) => `${e.component}:${e.event}`),
      ['tts:stream-open', 'tts:utterance-start', 'tts:request-or-flush', 'tts:first-audio', 'tts:utterance-done', 'tts:closed'],
    );
    const done = events.find((e) => e.event === 'utterance-done')!;
    assert.equal(done['chunks'], 2);
    assert.equal(done['bytes'], 3);
    assert.equal(typeof done['firstMs'], 'number');
    assert.equal(events[1]!['chars'], 'Welcome.'.length);
  });

  it('traces server errors and idle timeouts for the fallback decision', async () => {
    const events: TraceEvent[] = [];
    const socket = new FakeStreamSocket();
    const tts = new SarvamStreamingTts({
      config: { ...CONFIG, idleTimeoutMs: 20 },
      connect: () => socket,
      onTrace: (e) => events.push(e),
    });
    socket.peerOpen();
    const first = collect(tts.synthesizeStream('Boom.'));
    socket.peerMessage({ type: 'error', data: { message: 'bad request', code: 400 } });
    await assert.rejects(() => first.done, /sarvam-tts-stream-error-400/);
    assert.ok(events.some((e) => e.event === 'provider-error' && e['code'] === 400));
    const second = collect(tts.synthesizeStream('Silence.'));
    await assert.rejects(() => second.done, /sarvam-tts-stream-timeout/);
    assert.ok(events.some((e) => e.event === 'idle-timeout'));
    tts.close();
  });

  it('throws when synthesize has no REST fallback configured', async () => {
    const h = harness();
    await assert.rejects(() => h.tts.synthesize('Hello.'), /sarvam-tts-no-fallback/);
    h.tts.close();
  });
});

describe('SarvamStreamingTts incremental response', () => {
  it('takes several text chunks and one flush for a single response', async () => {
    const h = harnessMulti();
    h.socket().peerOpen();
    const response = h.tts.begin!({ generation: 9 });
    response.pushText('Welcome ');
    response.pushText('to the clinic.');
    response.finishText();
    const audio = collect(response.audio());
    assert.deepEqual(
      h.socket().sentJson().map((m) => m['type']),
      ['config', 'text', 'text', 'flush'],
    );
    assert.deepEqual(h.socket().sentJson()[1]!['data'], { text: 'Welcome ' });
    h.socket().peerMessage(audioMessage([1]));
    h.socket().peerMessage(audioMessage([2]));
    h.socket().peerMessage(FINAL);
    assert.deepEqual(await audio.done, [Buffer.from([1]), Buffer.from([2])]);
    assert.equal(response.generation, 9);
    h.tts.close();
  });

  it('cancel settles audio, drops late chunks, and reconnects the next response', async () => {
    const h = harnessMulti();
    h.socket().peerOpen();
    const response = h.tts.begin!({ generation: 1 });
    response.pushText('One.');
    response.finishText();
    const audio = collect(response.audio());
    h.socket().peerMessage(audioMessage([1]));
    response.cancel('caller-barge-in');
    h.socket().peerMessage(audioMessage([99]));
    assert.deepEqual(await audio.done, [Buffer.from([1])]);
    assert.equal(h.sockets.length, 2, 'a fresh socket is opened for the next response');
    const next = h.tts.begin!({ generation: 2 });
    next.pushText('Two.');
    next.finishText();
    const nextAudio = collect(next.audio());
    h.socket().peerOpen();
    h.socket().peerMessage(audioMessage([7]));
    h.socket().peerMessage(FINAL);
    assert.deepEqual(await nextAudio.done, [Buffer.from([7])]);
    h.tts.close();
  });

  it('cancel resolves audio that never produced a chunk', async () => {
    const h = harnessMulti();
    h.socket().peerOpen();
    const response = h.tts.begin!({ generation: 3 });
    response.pushText('Nothing.');
    response.finishText();
    const audio = collect(response.audio());
    response.cancel('interrupted');
    assert.deepEqual(await audio.done, []);
    h.tts.close();
  });

  it('aborts the utterance when the speech signal fires', async () => {
    const h = harnessMulti();
    h.socket().peerOpen();
    const controller = new AbortController();
    const response = h.tts.begin!({ generation: 5, signal: controller.signal });
    response.pushText('Hello.');
    response.finishText();
    const audio = collect(response.audio());
    h.socket().peerMessage(audioMessage([1]));
    controller.abort('caller-barge-in');
    assert.deepEqual(await audio.done, [Buffer.from([1])], 'audio settles with chunks so far');
    assert.equal(h.sockets[0]!.closed, true, 'the provider socket closes on abort');
    const next = h.tts.begin!({ generation: 6 });
    next.pushText('Two.');
    next.finishText();
    const nextAudio = collect(next.audio());
    h.socket().peerOpen();
    h.socket().peerMessage(audioMessage([7]));
    h.socket().peerMessage(FINAL);
    assert.deepEqual(await nextAudio.done, [Buffer.from([7])]);
    h.tts.close();
  });

  it('close cancels the streaming utterance without holding the socket', async () => {
    const h = harness();
    h.socket.peerOpen();
    const controller = new AbortController();
    const response = h.tts.begin!({ generation: 8, signal: controller.signal });
    response.pushText('Bye.');
    response.finishText();
    const audio = collect(response.audio());
    controller.abort('call-closed');
    assert.deepEqual(await audio.done, []);
    assert.equal(h.socket.closed, true);
    h.tts.close();
  });
});
