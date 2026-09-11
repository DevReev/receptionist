import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SarvamTranscriber, SarvamTts } from '../src/sarvam.ts';
import { encodeWav } from '../src/audio.ts';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const STT = {
  apiKey: 'sk-sarvam',
  baseUrl: 'http://stub-sarvam',
  model: 'saaras:v3',
  languageCode: 'en-IN',
  mode: 'transcribe',
};

describe('SarvamTranscriber', () => {
  it('posts multipart to speech-to-text and returns the transcript', async () => {
    let url = '';
    let key = '';
    let model = '';
    let language = '';
    let mode = '';
    let filename = '';
    const fetchFn = (async (u: string, init: { headers: Record<string, string>; body: FormData }) => {
      url = String(u);
      key = init.headers['api-subscription-key'];
      model = String(init.body.get('model'));
      language = String(init.body.get('language_code'));
      mode = String(init.body.get('mode'));
      const file = init.body.get('file');
      filename = file instanceof File ? file.name : '';
      return jsonResponse({ transcript: 'I want to book an appointment.' });
    }) as unknown as typeof fetch;
    const t = new SarvamTranscriber({ stt: STT, fetchFn });
    const out = await t.transcribe(Buffer.from('audio'), 'audio/wav');
    assert.equal(url, 'http://stub-sarvam/speech-to-text');
    assert.equal(key, 'sk-sarvam');
    assert.equal(model, 'saaras:v3');
    assert.equal(language, 'en-IN');
    assert.equal(mode, 'transcribe');
    assert.equal(filename, 'turn.wav');
    assert.equal(out.text, 'I want to book an appointment.');
    assert.equal(out.noSpeech, false);
  });

  it('treats an empty transcript as no-speech', async () => {
    const t = new SarvamTranscriber({
      stt: STT,
      fetchFn: (async () => jsonResponse({ transcript: '' })) as typeof fetch,
    });
    const out = await t.transcribe(Buffer.from('audio'), 'audio/mpeg');
    assert.equal(out.noSpeech, true);
  });

  it('throws on provider errors', async () => {
    const t = new SarvamTranscriber({
      stt: STT,
      fetchFn: (async () => jsonResponse({ error: 'boom' }, 500)) as typeof fetch,
    });
    await assert.rejects(() => t.transcribe(Buffer.from('audio'), 'audio/mpeg'));
  });
});

const TTS = {
  apiKey: 'sk-sarvam',
  baseUrl: 'http://stub-sarvam',
  model: 'bulbul:v3',
  speaker: 'shubh',
  languageCode: 'en-IN',
  sampleRate: 8000,
};

describe('SarvamTts', () => {
  it('posts json and returns playable mulaw audio from the base64 wav', async () => {
    let url = '';
    let key = '';
    let body: Record<string, unknown> = {};
    const b64 = encodeWav(new Int16Array([0, 1000, -1000, 2000]), 8000).toString('base64');
    const fetchFn = (async (u: string, init: { headers: Record<string, string>; body: string }) => {
      url = String(u);
      key = init.headers['api-subscription-key'];
      body = JSON.parse(init.body) as Record<string, unknown>;
      return jsonResponse({ audios: [b64] });
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
    assert.equal(body.output_audio_codec, 'wav');
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
});
