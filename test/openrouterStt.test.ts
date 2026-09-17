import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouterStt, discoverTranscriptionModels } from '../src/openrouterStt.ts';
import type { TraceEvent } from '../src/trace.ts';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const STT = { apiKey: 'sk-or', baseUrl: 'http://stub-openrouter/api/v1' };

describe('OpenRouterStt', () => {
  it('posts multipart audio with bearer auth, model, and no prompt field', async () => {
    let url = '';
    let auth = '';
    let model = '';
    let filename = '';
    let fileType = '';
    let prompt: string | null = null;
    const fetchFn = (async (u: string, init: { headers: Record<string, string>; body: FormData }) => {
      url = String(u);
      auth = init.headers.Authorization;
      model = String(init.body.get('model'));
      const promptField = init.body.get('prompt');
      prompt = promptField === null ? null : String(promptField);
      const file = init.body.get('file');
      filename = file instanceof File ? file.name : '';
      fileType = file instanceof File ? file.type : '';
      return jsonResponse({ text: 'I want to book an appointment.' });
    }) as unknown as typeof fetch;
    const t = new OpenRouterStt({ stt: STT, fetchFn });
    const out = await t.transcribe(Buffer.from('audio'), 'audio/wav');
    assert.equal(url, 'http://stub-openrouter/api/v1/audio/transcriptions');
    assert.equal(auth, 'Bearer sk-or');
    assert.equal(model, 'openai/gpt-4o-transcribe');
    assert.equal(filename, 'turn.wav');
    assert.equal(fileType, 'audio/wav');
    assert.equal(prompt, null);
    assert.equal(out.text, 'I want to book an appointment.');
    assert.equal(out.noSpeech, false);
  });

  it('names a non-wav upload turn.mp3 and defaults its type', async () => {
    let filename = '';
    let fileType = '';
    const fetchFn = (async (_u: string, init: { body: FormData }) => {
      const file = init.body.get('file');
      filename = file instanceof File ? file.name : '';
      fileType = file instanceof File ? file.type : '';
      return jsonResponse({ text: 'hi' });
    }) as unknown as typeof fetch;
    const t = new OpenRouterStt({ stt: STT, fetchFn });
    await t.transcribe(Buffer.from('audio'), '');
    assert.equal(filename, 'turn.mp3');
    assert.equal(fileType, 'audio/mpeg');
  });

  it('accepts a transcript field defensively', async () => {
    const t = new OpenRouterStt({
      stt: STT,
      fetchFn: (async () => jsonResponse({ transcript: 'from the fallback shape' })) as typeof fetch,
    });
    const out = await t.transcribe(Buffer.from('audio'), 'audio/mpeg');
    assert.equal(out.text, 'from the fallback shape');
    assert.equal(out.noSpeech, false);
  });

  it('flags an empty transcript as no-speech', async () => {
    const t = new OpenRouterStt({
      stt: STT,
      fetchFn: (async () => jsonResponse({ text: '   ' })) as typeof fetch,
    });
    const out = await t.transcribe(Buffer.from('audio'), 'audio/mpeg');
    assert.equal(out.noSpeech, true);
  });

  it('throws the status on provider errors', async () => {
    const t = new OpenRouterStt({
      stt: STT,
      fetchFn: (async () => jsonResponse({ error: 'boom' }, 502)) as typeof fetch,
    });
    await assert.rejects(() => t.transcribe(Buffer.from('audio'), 'audio/mpeg'), /openrouter-stt-http-502/);
  });

  it('traces start and done with bytes, model, timing, chars, and noSpeech', async () => {
    const events: TraceEvent[] = [];
    const t = new OpenRouterStt({
      stt: STT,
      fetchFn: (async () => jsonResponse({ text: 'hello clinic' })) as typeof fetch,
      onTrace: (e) => events.push(e),
    });
    await t.transcribe(Buffer.from('abcd'), 'audio/wav');
    assert.deepEqual(
      events.map((e) => `${e.component}:${e.event}`),
      ['stt:openrouter-start', 'stt:openrouter-done'],
    );
    assert.equal(events[0]!['bytes'], 4);
    assert.equal(events[0]!['model'], 'openai/gpt-4o-transcribe');
    assert.equal(events[1]!['chars'], 'hello clinic'.length);
    assert.equal(events[1]!['noSpeech'], false);
    assert.equal(typeof events[1]!['ms'], 'number');
  });

  it('traces errors with timing and detail', async () => {
    const events: TraceEvent[] = [];
    const t = new OpenRouterStt({
      stt: STT,
      fetchFn: (async () => jsonResponse({ error: 'boom' }, 500)) as typeof fetch,
      onTrace: (e) => events.push(e),
    });
    await assert.rejects(() => t.transcribe(Buffer.from('audio'), 'audio/mpeg'));
    assert.deepEqual(
      events.map((e) => `${e.component}:${e.event}`),
      ['stt:openrouter-start', 'stt:openrouter-error'],
    );
    assert.match(String(events[1]!['detail']), /openrouter-stt-http-500/);
    assert.equal(typeof events[1]!['ms'], 'number');
  });
});

describe('discoverTranscriptionModels', () => {
  it('gets transcription models from the models endpoint and returns sorted ids', async () => {
    let url = '';
    let auth = '';
    const fetchFn = (async (u: string, init: { headers: Record<string, string> }) => {
      url = String(u);
      auth = init.headers.Authorization;
      return jsonResponse({ data: [{ id: 'z/model' }, { id: 'a/model' }, { id: 'm/model' }] });
    }) as unknown as typeof fetch;
    const models = await discoverTranscriptionModels({
      apiKey: 'sk-or',
      baseUrl: 'http://stub-openrouter/api/v1',
      fetchFn,
    });
    assert.equal(url, 'http://stub-openrouter/api/v1/models?output_modalities=transcription');
    assert.equal(auth, 'Bearer sk-or');
    assert.deepEqual(models, ['a/model', 'm/model', 'z/model']);
  });

  it('returns an empty list for malformed payloads', async () => {
    const fetchFn = (async () => jsonResponse({ data: 'not-an-array' })) as typeof fetch;
    assert.deepEqual(await discoverTranscriptionModels({ apiKey: 'k', fetchFn }), []);
  });

  it('throws the status on provider errors', async () => {
    const fetchFn = (async () => jsonResponse({ error: 'boom' }, 401)) as typeof fetch;
    await assert.rejects(
      () => discoverTranscriptionModels({ apiKey: 'k', fetchFn }),
      /openrouter-models-http-401/,
    );
  });
});
