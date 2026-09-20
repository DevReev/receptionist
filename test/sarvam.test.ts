import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SarvamTts } from '../src/sarvam.ts';
import type { TraceEvent } from '../src/trace.ts';
import { encodeWav } from '../src/audio.ts';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const TTS = {
  apiKey: 'sk-sarvam',
  baseUrl: 'http://stub-sarvam',
  model: 'bulbul:v3',
  speaker: 'shubh',
  languageCode: 'en-IN',
  sampleRate: 8000,
};

describe('SarvamTts', () => {
  it('requests native 8 kHz mu-law and returns the bytes untouched', async () => {
    let url = '';
    let key = '';
    let body: Record<string, unknown> = {};
    const mulawBytes = Buffer.from([1, 2, 3, 4]);
    const fetchFn = (async (u: string, init: { headers: Record<string, string>; body: string }) => {
      url = String(u);
      key = init.headers['api-subscription-key'];
      body = JSON.parse(init.body) as Record<string, unknown>;
      return jsonResponse({ audios: [mulawBytes.toString('base64')] });
    }) as unknown as typeof fetch;
    const tts = new SarvamTts({ tts: TTS, fetchFn });
    const out = await tts.synthesize('Welcome to Bobby Clinic.');
    assert.equal(url, 'http://stub-sarvam/text-to-speech');
    assert.equal(key, 'sk-sarvam');
    assert.equal(body.text, 'Welcome to Bobby Clinic.');
    assert.equal(body.language_code, 'en-IN');
    assert.equal(body.speaker, 'shubh');
    assert.equal(body.model, 'bulbul:v3');
    assert.equal(body.speech_sample_rate, 8000);
    assert.equal(body.output_audio_codec, 'mulaw');
    assert.deepEqual(out.audio, mulawBytes);
  });

  it('falls back to WAV parsing when the provider returns RIFF bytes', async () => {
    const b64 = encodeWav(new Int16Array([0, 1000, -1000, 2000]), 8000).toString('base64');
    const tts = new SarvamTts({
      tts: TTS,
      fetchFn: (async () => jsonResponse({ audios: [b64] })) as typeof fetch,
    });
    const out = await tts.synthesize('hello');
    // 4 samples @ 8 kHz become 4 mulaw bytes with no resampling.
    assert.equal(out.audio.length, 4);
  });

  it('throws when the provider returns no audio', async () => {
    const tts = new SarvamTts({
      tts: TTS,
      fetchFn: (async () => jsonResponse({ audios: [] })) as typeof fetch,
    });
    await assert.rejects(() => tts.synthesize('hello'));
  });

  it('throws on provider errors', async () => {
    const tts = new SarvamTts({
      tts: TTS,
      fetchFn: (async () => jsonResponse({ error: 'boom' }, 500)) as typeof fetch,
    });
    await assert.rejects(() => tts.synthesize('hello'));
  });

  it('traces REST speech timing', async () => {
    const ttsEvents: TraceEvent[] = [];
    const b64 = encodeWav(new Int16Array([0, 1000]), 8000).toString('base64');
    const tts = new SarvamTts({
      tts: TTS,
      fetchFn: (async () => jsonResponse({ audios: [b64] })) as typeof fetch,
      onTrace: (e) => ttsEvents.push(e),
    });
    await tts.synthesize('hello');
    assert.deepEqual(
      ttsEvents.map((e) => `${e.component}:${e.event}`),
      ['tts:rest-start', 'tts:rest-done'],
    );
  });
});
