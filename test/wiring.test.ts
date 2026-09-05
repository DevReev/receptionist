import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';
import { formatFailureLine } from '../src/log.ts';
import { createInterimGuardrail } from '../src/booking.ts';
import type { FailureEvent } from '../src/app.ts';

describe('config', () => {
  it('fails fast listing every missing credential', () => {
    assert.throws(() => loadConfig({}), /GROQ_API_KEY.*OPEN_ROUTER|OPEN_ROUTER.*GROQ_API_KEY/);
  });

  it('prefers explicit whisper overrides over inferred provider defaults', () => {
    const cfg = loadConfig({
      GROQ_API_KEY: 'g',
      OPEN_ROUTER: 'o',
      TWILIO_ACCOUNT_SID: 'ACx',
      TWILIO_AUTH_TOKEN: 't',
      WHISPER_BASE_URL: 'http://stub-whisper/v1',
      WHISPER_MODEL: 'stub-model',
    });
    assert.equal(cfg.whisperBaseUrl, 'http://stub-whisper/v1');
    assert.equal(cfg.whisperModel, 'stub-model');
    assert.equal(cfg.sttApiKey, 'g');
    assert.equal(cfg.llmApiKey, 'o');
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
