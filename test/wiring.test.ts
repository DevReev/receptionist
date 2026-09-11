import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';
import { formatFailureLine } from '../src/log.ts';
import { createInterimGuardrail } from '../src/booking.ts';
import type { FailureEvent } from '../src/app.ts';

describe('config', () => {
  it('fails fast listing every missing credential', () => {
    assert.throws(() => loadConfig({}), /OPENROUTER_API_KEY.*GROQ_API_KEY|GROQ_API_KEY.*OPENROUTER_API_KEY/);
  });

  it('prefers explicit whisper overrides over inferred provider defaults', () => {
    const cfg = loadConfig({
      GROQ_API_KEY: 'g',
      OPENROUTER_API_KEY: 'o',
      TWILIO_ACCOUNT_SID: 'ACx',
      TWILIO_AUTH_TOKEN: 't',
      STREAM_WS_URL: 'wss://example.com/stream',
      WHISPER_BASE_URL: 'http://stub-whisper/v1',
      WHISPER_MODEL: 'stub-model',
    });
    assert.deepEqual(cfg.stt, {
      apiKey: 'g',
      baseUrl: 'http://stub-whisper/v1',
      model: 'stub-model',
    });
    assert.equal(cfg.llmApiKey, 'o');
  });

  it('routes TTS through OpenRouter with overridable model and voice', () => {
    const cfg = loadConfig({
      OPENAI_API_KEY: 'sk-stt',
      OPENROUTER_API_KEY: 'o',
      TWILIO_ACCOUNT_SID: 'ACx',
      TWILIO_AUTH_TOKEN: 't',
      STREAM_WS_URL: 'wss://example.com/stream',
    });
    assert.equal(cfg.tts.apiKey, 'o');
    assert.equal(cfg.tts.baseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(cfg.tts.model, 'qwen/qwen-audio-3.0-tts-flash');
    assert.equal(cfg.tts.voice, 'loongjohn');
    assert.equal(cfg.tts.responseFormat, 'pcm');
    assert.equal(cfg.tts.pcmSampleRate, 24000);
    const custom = loadConfig({
      OPENAI_API_KEY: 'sk-stt',
      OPENROUTER_API_KEY: 'o',
      TWILIO_ACCOUNT_SID: 'ACx',
      TWILIO_AUTH_TOKEN: 't',
      STREAM_WS_URL: 'wss://example.com/stream',
      TTS_API_KEY: 'sk-tts-dedicated',
      TTS_MODEL: 'mistralai/voxtral-mini-tts-2603',
      TTS_VOICE: 'some-voice',
    });
    assert.equal(custom.tts.apiKey, 'sk-tts-dedicated');
    assert.equal(custom.tts.model, 'mistralai/voxtral-mini-tts-2603');
    assert.equal(custom.tts.voice, 'some-voice');
  });

  it('rejects unknown TTS response formats', () => {
    assert.throws(
      () =>
        loadConfig({
          OPENROUTER_API_KEY: 'o',
          TWILIO_ACCOUNT_SID: 'ACx',
          TWILIO_AUTH_TOKEN: 't',
          GROQ_API_KEY: 'g',
          STREAM_WS_URL: 'wss://example.com/stream',
          TTS_RESPONSE_FORMAT: 'wav99',
        }),
      /TTS_RESPONSE_FORMAT/,
    );
  });
});

describe('failure log line', () => {
  it('is a JSON line carrying call identity and reason', () => {
    const event: FailureEvent = { callSid: 'CA123', turn: 3, reason: 'save-failed', excerpt: 'yes book it' };
    const parsed = JSON.parse(formatFailureLine(event)) as Record<string, unknown>;
    assert.equal(parsed.callSid, 'CA123');
    assert.equal(parsed.turn, 3);
    assert.equal(parsed.reason, 'save-failed');
    assert.equal(parsed.excerpt, 'yes book it');
    assert.equal(typeof parsed.ts, 'string');
  });
});

describe('interim booking guardrail', () => {
  it('rejects every proposed slot until availability lands, and logs it', async () => {
    const failures: FailureEvent[] = [];
    const guardrail = createInterimGuardrail((e) => failures.push(e));
    const outcome = await guardrail({
      callSid: 'CA123',
      turn: 5,
      excerpt: 'yes book Wednesday',
      slot: {
        service: 'Sample Service',
        date: '2026-09-30',
        time: '09:30',
        callerName: 'Asha',
        callerPhone: '+911234567890',
      },
    });
    assert.equal(outcome.ok, false);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].reason, 'save-failed');
    assert.equal(failures[0].callSid, 'CA123');
  });
});
