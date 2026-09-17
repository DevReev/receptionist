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
});
