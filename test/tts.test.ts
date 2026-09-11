import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiTts } from '../src/tts.ts';
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
    assert.ok(out.audio.length > 0);
  });

  it('throws on provider errors', async () => {
    const fetchFn = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const tts = new OpenAiTts({ apiKey: 'k', fetchFn });
    await assert.rejects(() => tts.synthesize('hello'));
  });
});
