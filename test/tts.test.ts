import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiTts } from '../src/tts.ts';
import type { TraceEvent } from '../src/trace.ts';
import { encodeWav } from '../src/audio.ts';

function wavResponse(): Response {
  const wav = encodeWav(new Int16Array([0, 500, -500, 0]), 24000);
  return new Response(wav as unknown as BodyInit, {
    status: 200,
    headers: { 'content-type': 'audio/wav' },
  });
}

describe('OpenAiTts', () => {
  it('posts text and returns playable mulaw audio', async () => {
    let url = '';
    let auth = '';
    let body: Record<string, unknown> = {};
    const fetchFn = (async (u: string, init: { headers: Record<string, string>; body: string }) => {
      url = String(u);
      auth = init.headers.Authorization;
      body = JSON.parse(init.body) as Record<string, unknown>;
      return wavResponse();
    }) as unknown as typeof fetch;
    const tts = new OpenAiTts({
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'tts-1',
      voice: 'alloy',
      fetchFn,
    });
    const out = await tts.synthesize('Welcome to Maple Clinic.');
    assert.equal(url, 'https://api.openai.com/v1/audio/speech');
    assert.equal(auth, 'Bearer sk-test');
    assert.equal(body.model, 'tts-1');
    assert.equal(body.voice, 'alloy');
    assert.equal(body.input, 'Welcome to Maple Clinic.');
    assert.equal(body.response_format, 'wav');
    assert.ok(out.audio.length > 0);
  });

  it('requests raw pcm when configured and converts it to 8 kHz mulaw', async () => {
    let body: Record<string, unknown> = {};
    const pcm = new Int16Array([0, 1000, -1000, 2000, -2000, 3000, -3000, 4000]);
    const fetchFn = (async (_u: string, init: { headers: Record<string, string>; body: string }) => {
      body = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(Buffer.from(pcm.buffer) as unknown as BodyInit, {
        status: 200,
        headers: { 'content-type': 'audio/pcm;rate=24000;channels=1' },
      });
    }) as unknown as typeof fetch;
    const tts = new OpenAiTts({ apiKey: 'k', fetchFn, responseFormat: 'pcm', pcmSampleRate: 24000 });
    const out = await tts.synthesize('hello');
    assert.equal(body.response_format, 'pcm');
    // 8 samples @ 24 kHz resample to 8 kHz.
    assert.equal(out.audio.length, 3);
  });

  it('throws on provider errors', async () => {
    const fetchFn = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const tts = new OpenAiTts({ apiKey: 'k', fetchFn });
    await assert.rejects(() => tts.synthesize('hello'));
  });

  it('traces REST synthesis start, completion, and failure', async () => {
    const okEvents: TraceEvent[] = [];
    const ok = new OpenAiTts({
      apiKey: 'k',
      fetchFn: (async () => wavResponse()) as unknown as typeof fetch,
      onTrace: (e) => okEvents.push(e),
    });
    await ok.synthesize('hello');
    assert.deepEqual(
      okEvents.map((e) => `${e.component}:${e.event}`),
      ['tts:rest-start', 'tts:rest-done'],
    );
    assert.equal(okEvents[1]!['bytes'] !== 0, true);

    const failEvents: TraceEvent[] = [];
    const bad = new OpenAiTts({
      apiKey: 'k',
      fetchFn: (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch,
      onTrace: (e) => failEvents.push(e),
    });
    await assert.rejects(() => bad.synthesize('hello'));
    assert.equal(failEvents.at(-1)!['event'], 'rest-error');
    assert.match(String(failEvents.at(-1)!['detail']), /tts-http-500/);
  });

  it('streams raw PCM chunks to 8 kHz mu-law as the HTTP body arrives', async () => {
    const pcm = new Int16Array(24).fill(1000);
    const raw = Buffer.from(pcm.buffer);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(raw.subarray(0, 17));
        controller.enqueue(raw.subarray(17));
        controller.close();
      },
    });
    const tts = new OpenAiTts({
      apiKey: 'k',
      fetchFn: (async () =>
        new Response(stream, { status: 200, headers: { 'content-type': 'audio/pcm;rate=24000' } })) as unknown as typeof fetch,
      responseFormat: 'pcm',
      pcmSampleRate: 24000,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of tts.synthesizeStream!('hello')) chunks.push(chunk);
    // 24 samples @ 24 kHz downsample to 8 samples @ 8 kHz.
    assert.equal(Buffer.concat(chunks).length, 8);
  });

  it('runs a response session over the streaming path', async () => {
    const pcm = new Int16Array([0, 1000, -1000, 2000, -2000, 3000, -3000, 4000]);
    const tts = new OpenAiTts({
      apiKey: 'k',
      fetchFn: (async () =>
        new Response(Buffer.from(pcm.buffer) as unknown as BodyInit, {
          status: 200,
          headers: { 'content-type': 'audio/pcm;rate=24000' },
        })) as unknown as typeof fetch,
      responseFormat: 'pcm',
      pcmSampleRate: 24000,
    });
    const response = tts.begin!({ generation: 4 });
    response.pushText('Hello.');
    response.finishText();
    const chunks: Buffer[] = [];
    for await (const chunk of response.audio()) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).length, 3);
  });

  it('passes the abort signal to the provider fetch', async () => {
    let seen: AbortSignal | null = null;
    const fetchFn = ((_: string, init: { signal?: AbortSignal }) => {
      seen = init.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }) as unknown as typeof fetch;
    const tts = new OpenAiTts({ apiKey: 'k', fetchFn });
    const controller = new AbortController();
    const pending = tts.synthesize('hello mid-synthesis', controller.signal);
    assert.ok(seen !== null, 'the provider request carries the abort signal');
    controller.abort('caller-barge-in');
    await assert.rejects(() => pending, /abort/i);
    assert.equal((seen as unknown as AbortSignal).aborted, true, 'barge-in aborts the in-flight request, not just late chunks');
  });

  it('aborts an in-flight streaming body read instead of only dropping chunks', async () => {
    let seen: AbortSignal | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // Never yields: the abort must settle the read.
      },
    });
    const fetchFn = ((_: string, init: { signal?: AbortSignal }) => {
      seen = init.signal ?? null;
      if (init.signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        void stream;
      });
    }) as unknown as typeof fetch;
    const tts = new OpenAiTts({ apiKey: 'k', fetchFn, responseFormat: 'pcm', pcmSampleRate: 24000 });
    const controller = new AbortController();
    const gen = tts.synthesizeStream!('hello mid-synthesis', controller.signal)[Symbol.asyncIterator]();
    const next = gen.next();
    await new Promise((r) => setTimeout(r, 10));
    controller.abort('caller-barge-in');
    await assert.rejects(() => next, /abort/i);
    assert.equal((seen as unknown as AbortSignal).aborted, true);
  });

  it('bufferedSpeech aborts the in-flight phrase request and stops queueing', async () => {
    let phraseSignal: AbortSignal | null = null;
    let fallbackCalls = 0;
    const tts = {
      synthesize: async (_text: string, signal?: AbortSignal) => {
        phraseSignal = signal ?? null;
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(new DOMException('aborted', 'AbortError'));
            return;
          }
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
        return { audio: Buffer.from([0x01]) };
      },
    };
    const { bufferedSpeech } = await import('../src/tts.ts');
    const controller = new AbortController();
    const response = bufferedSpeech(tts, {
      generation: 1,
      signal: controller.signal,
      onFallback: () => {
        fallbackCalls += 1;
      },
    });
    response.pushText('Hello mid-synthesis.');
    response.finishText();
    const drain = (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of response.audio()) chunks.push(chunk);
      return chunks;
    })();
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(phraseSignal !== null, 'the phrase request carries the signal');
    controller.abort('caller-barge-in');
    assert.deepEqual(await drain, [], 'cancellation settles audio without chunks');
    assert.equal((phraseSignal as unknown as AbortSignal).aborted, true, 'the in-flight phrase request aborts');
    assert.equal(fallbackCalls, 0, 'an abort never falls back to one-shot');
  });

  it('still falls back to one-shot when the stream fails before any audio', async () => {
    const { bufferedSpeech } = await import('../src/tts.ts');
    const seen: string[] = [];
    const tts = {
      synthesize: async (text: string) => {
        seen.push(text);
        return { audio: Buffer.from([0x09]) };
      },
      synthesizeStream: async function* (_text: string) {
        throw new Error('provider-down');
      },
    };
    const response = bufferedSpeech(tts, { generation: 7 });
    response.pushText('Fallback reply.');
    response.finishText();
    const chunks: Buffer[] = [];
    for await (const chunk of response.audio()) chunks.push(chunk);
    assert.deepEqual(seen, ['Fallback reply.']);
    assert.deepEqual(chunks, [Buffer.from([0x09])]);
  });
});
