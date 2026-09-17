import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';
import { formatFailureLine } from '../src/log.ts';
import { createInterimGuardrail } from '../src/booking.ts';
import type { FailureEvent } from '../src/app.ts';

describe('config', () => {
  it('fails fast listing every missing credential', () => {
    assert.throws(() => loadConfig({}), /SARVAM_API_KEY.*OPENROUTER_API_KEY|OPENROUTER_API_KEY.*SARVAM_API_KEY/);
  });

  it('defaults STT to Sarvam without requiring a Whisper key', () => {
    const cfg = loadConfig({
      OPENROUTER_API_KEY: 'o',
      TWILIO_ACCOUNT_SID: 'ACx',
      TWILIO_AUTH_TOKEN: 't',
      STREAM_WS_URL: 'wss://example.com/stream',
      SARVAM_API_KEY: 'sk-sarvam',
    });
    assert.equal(cfg.sttProvider, 'sarvam');
    assert.equal(cfg.sarvam.sttModel, 'saaras:v3');
  });

  it('prefers explicit whisper overrides when the provider is selected', () => {
    const cfg = loadConfig({
      GROQ_API_KEY: 'g',
      OPENROUTER_API_KEY: 'o',
      TWILIO_ACCOUNT_SID: 'ACx',
      TWILIO_AUTH_TOKEN: 't',
      STREAM_WS_URL: 'wss://example.com/stream',
      STT_PROVIDER: 'groq',
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

  it('uses the selected Whisper provider key when both keys are present', () => {
    const base = {
      OPENAI_API_KEY: 'openai-key',
      GROQ_API_KEY: 'groq-key',
      OPENROUTER_API_KEY: 'o',
      TWILIO_ACCOUNT_SID: 'ACx',
      TWILIO_AUTH_TOKEN: 't',
      STREAM_WS_URL: 'wss://example.com/stream',
    };
    assert.equal(loadConfig({ ...base, STT_PROVIDER: 'groq' }).stt.apiKey, 'groq-key');
    assert.equal(loadConfig({ ...base, STT_PROVIDER: 'openai' }).stt.apiKey, 'openai-key');
  });

  it('routes TTS through OpenRouter with overridable model and voice', () => {
    const cfg = loadConfig({
      OPENAI_API_KEY: 'sk-stt',
      OPENROUTER_API_KEY: 'o',
      TWILIO_ACCOUNT_SID: 'ACx',
      TWILIO_AUTH_TOKEN: 't',
      STREAM_WS_URL: 'wss://example.com/stream',
      SARVAM_API_KEY: 'sk-sarvam',
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
      SARVAM_API_KEY: 'sk-sarvam',
      TTS_API_KEY: 'sk-tts-dedicated',
      TTS_MODEL: 'mistralai/voxtral-mini-tts-2603',
      TTS_VOICE: 'some-voice',
    });
    assert.equal(custom.tts.apiKey, 'sk-tts-dedicated');
    assert.equal(custom.tts.model, 'mistralai/voxtral-mini-tts-2603');
    assert.equal(custom.tts.voice, 'some-voice');
  });

  it('selects Sarvam for STT and TTS without requiring a Whisper key', () => {
    const cfg = loadConfig({
      OPENROUTER_API_KEY: 'o',
      TWILIO_ACCOUNT_SID: 'ACx',
      TWILIO_AUTH_TOKEN: 't',
      STREAM_WS_URL: 'wss://example.com/stream',
      SARVAM_API_KEY: 'sk-sarvam',
      STT_PROVIDER: 'sarvam',
      TTS_PROVIDER: 'sarvam',
    });
    assert.equal(cfg.sttProvider, 'sarvam');
    assert.equal(cfg.ttsProvider, 'sarvam');
    assert.equal(cfg.sarvam.apiKey, 'sk-sarvam');
    assert.equal(cfg.sarvam.baseUrl, 'https://api.sarvam.ai');
    assert.equal(cfg.sarvam.sttModel, 'saaras:v3');
    assert.equal(cfg.sarvam.ttsModel, 'bulbul:v3');
    assert.equal(cfg.sarvam.ttsSpeaker, 'shubh');
    assert.equal(cfg.sarvam.ttsSampleRate, 8000);
  });

  it('defaults Sarvam streaming TTS on, overridable', () => {
    const base = {
      OPENROUTER_API_KEY: 'o',
      TWILIO_ACCOUNT_SID: 'ACx',
      TWILIO_AUTH_TOKEN: 't',
      STREAM_WS_URL: 'wss://example.com/stream',
      SARVAM_API_KEY: 'sk-sarvam',
    };
    const cfg = loadConfig(base);
    assert.equal(cfg.sarvam.ttsStream, true);
    assert.equal(cfg.sarvam.ttsStreamIdleTimeoutMs, 5000);
    const tuned = loadConfig({ ...base, SARVAM_TTS_STREAM: 'false', SARVAM_TTS_STREAM_IDLE_TIMEOUT_MS: '1500' });
    assert.equal(tuned.sarvam.ttsStream, false);
    assert.equal(tuned.sarvam.ttsStreamIdleTimeoutMs, 1500);
  });

  it('defaults the Echo-gate margins, overridable', () => {
    const base = {
      OPENROUTER_API_KEY: 'o',
      TWILIO_ACCOUNT_SID: 'ACx',
      TWILIO_AUTH_TOKEN: 't',
      STREAM_WS_URL: 'wss://example.com/stream',
      SARVAM_API_KEY: 'sk-sarvam',
    };
    const cfg = loadConfig(base);
    assert.equal(cfg.echoGateCorrelation, 0.7);
    assert.equal(cfg.echoGateLevelMarginDb, 6);
    assert.equal(cfg.echoGateMaxDelayMs, 600);
    const tuned = loadConfig({
      ...base,
      ECHO_GATE_CORRELATION: '0.8',
      ECHO_GATE_LEVEL_MARGIN_DB: '9',
      ECHO_GATE_MAX_DELAY_MS: '450',
    });
    assert.equal(tuned.echoGateCorrelation, 0.8);
    assert.equal(tuned.echoGateLevelMarginDb, 9);
    assert.equal(tuned.echoGateMaxDelayMs, 450);
  });

  it('defaults live STT to the Sarvam realtime websocket, overridable', () => {
    const base = {
      OPENROUTER_API_KEY: 'o',
      TWILIO_ACCOUNT_SID: 'ACx',
      TWILIO_AUTH_TOKEN: 't',
      STREAM_WS_URL: 'wss://example.com/stream',
      SARVAM_API_KEY: 'sk-sarvam',
    };
    const cfg = loadConfig(base);
    assert.equal(cfg.sarvam.sttRealtime, true);
    assert.equal(cfg.sarvam.sttRealtimeModel, 'saaras:v3-realtime');
    assert.equal(cfg.sarvam.sttStreamType, 'fast');
    assert.equal(cfg.sarvam.sttFinalTimeoutMs, 2000);
    const tuned = loadConfig({
      ...base,
      SARVAM_STT_REALTIME: 'false',
      SARVAM_STT_STREAM_TYPE: 'balanced',
      SARVAM_STT_FINAL_TIMEOUT_MS: '1500',
    });
    assert.equal(tuned.sarvam.sttRealtime, false);
    assert.equal(tuned.sarvam.sttStreamType, 'balanced');
    assert.equal(tuned.sarvam.sttFinalTimeoutMs, 1500);
    assert.throws(() => loadConfig({ ...base, SARVAM_STT_STREAM_TYPE: 'warp' }), /SARVAM_STT_STREAM_TYPE/);
  });

  it('defaults turn boundaries to provider VAD with provider-default knobs, all tunable', () => {
    const base = {
      OPENROUTER_API_KEY: 'o',
      TWILIO_ACCOUNT_SID: 'ACx',
      TWILIO_AUTH_TOKEN: 't',
      STREAM_WS_URL: 'wss://example.com/stream',
      SARVAM_API_KEY: 'sk-sarvam',
    };
    const cfg = loadConfig(base);
    assert.equal(cfg.turnDetection, 'sarvam');
    assert.equal(cfg.sarvam.sttVadThreshold, 0.3);
    assert.equal(cfg.sarvam.sttVadSilenceMs, 500);
    assert.equal(cfg.sarvam.sttVadMinSpeechMs, 250);
    const tuned = loadConfig({
      ...base,
      TURN_DETECTION: 'hybrid',
      SARVAM_VAD_THRESHOLD: '0.45',
      SARVAM_VAD_SILENCE_MS: '620',
      SARVAM_VAD_MIN_SPEECH_MS: '260',
    });
    assert.equal(tuned.turnDetection, 'hybrid');
    assert.equal(tuned.sarvam.sttVadThreshold, 0.45);
    assert.equal(tuned.sarvam.sttVadSilenceMs, 620);
    assert.equal(tuned.sarvam.sttVadMinSpeechMs, 260);
    assert.throws(() => loadConfig({ ...base, TURN_DETECTION: 'local' }), /TURN_DETECTION/);
  });

  it('no longer carries the fixed silence and max-utterance knobs', () => {
    const cfg = loadConfig({
      OPENROUTER_API_KEY: 'o',
      TWILIO_ACCOUNT_SID: 'ACx',
      TWILIO_AUTH_TOKEN: 't',
      STREAM_WS_URL: 'wss://example.com/stream',
      SARVAM_API_KEY: 'sk-sarvam',
      ENDPOINT_SILENCE_MS: '1000',
      ENDPOINT_MAX_UTTERANCE_MS: '30000',
    });
    assert.equal(Object.hasOwn(cfg, 'endpointSilenceMs'), false);
    assert.equal(Object.hasOwn(cfg, 'endpointMaxUtteranceMs'), false);
  });

  it('keeps the Whisper/OpenAI providers selectable', () => {
    const cfg = loadConfig({
      OPENAI_API_KEY: 'sk-stt',
      OPENROUTER_API_KEY: 'o',
      TWILIO_ACCOUNT_SID: 'ACx',
      TWILIO_AUTH_TOKEN: 't',
      STREAM_WS_URL: 'wss://example.com/stream',
      STT_PROVIDER: 'openai',
      TTS_PROVIDER: 'openai',
    });
    assert.equal(cfg.sttProvider, 'openai');
    assert.equal(cfg.ttsProvider, 'openai');
    assert.equal(cfg.stt.apiKey, 'sk-stt');
    assert.equal(cfg.stt.baseUrl, 'https://api.openai.com/v1');
  });

  it('defaults the appointments API to the Render deploy with a 5-working-day window', () => {
    const cfg = loadConfig({
      GROQ_API_KEY: 'g',
      OPENROUTER_API_KEY: 'o',
      TWILIO_ACCOUNT_SID: 'ACx',
      TWILIO_AUTH_TOKEN: 't',
      STREAM_WS_URL: 'wss://example.com/stream',
      SARVAM_API_KEY: 'sk-sarvam',
    });
    assert.equal(cfg.appointments.baseUrl, 'https://receptionist-3r3d.onrender.com');
    assert.equal(cfg.appointments.windowWorkingDays, 5);
  });

  it('defaults the spoken hold, no-response watch, and availability deadline, all tunable', () => {
    const base = {
      GROQ_API_KEY: 'g',
      OPENROUTER_API_KEY: 'o',
      TWILIO_ACCOUNT_SID: 'ACx',
      TWILIO_AUTH_TOKEN: 't',
      STREAM_WS_URL: 'wss://example.com/stream',
      SARVAM_API_KEY: 'sk-sarvam',
    };
    const cfg = loadConfig(base);
    assert.equal(cfg.speakHoldMs, 3000);
    assert.equal(cfg.noResponseMs, 8000);
    assert.equal(cfg.appointmentsWaitMs, 10000);
    const tuned = loadConfig({ ...base, SPEAK_HOLD_MS: '1500', NO_RESPONSE_MS: '0', APPOINTMENTS_WAIT_MS: '0' });
    assert.equal(tuned.speakHoldMs, 1500);
    assert.equal(tuned.noResponseMs, 0);
    assert.equal(tuned.appointmentsWaitMs, 0);
  });

  it('overrides the appointments URL and validates the working-day window', () => {
    const base = {
      GROQ_API_KEY: 'g',
      OPENROUTER_API_KEY: 'o',
      TWILIO_ACCOUNT_SID: 'ACx',
      TWILIO_AUTH_TOKEN: 't',
      STREAM_WS_URL: 'wss://example.com/stream',
      SARVAM_API_KEY: 'sk-sarvam',
    };
    const cfg = loadConfig({
      ...base,
      APPOINTMENTS_API_URL: 'https://stub-api',
      APPOINTMENTS_WINDOW_WORKING_DAYS: '7',
    });
    assert.equal(cfg.appointments.baseUrl, 'https://stub-api');
    assert.equal(cfg.appointments.windowWorkingDays, 7);
    assert.throws(() => loadConfig({ ...base, APPOINTMENTS_WINDOW_WORKING_DAYS: '0' }), /APPOINTMENTS_WINDOW_WORKING_DAYS/);
    assert.throws(() => loadConfig({ ...base, APPOINTMENTS_WINDOW_WORKING_DAYS: '22' }), /APPOINTMENTS_WINDOW_WORKING_DAYS/);
  });

  it('requires SARVAM_API_KEY when a Sarvam provider is selected', () => {
    assert.throws(
      () =>
        loadConfig({
          OPENROUTER_API_KEY: 'o',
          TWILIO_ACCOUNT_SID: 'ACx',
          TWILIO_AUTH_TOKEN: 't',
          STREAM_WS_URL: 'wss://example.com/stream',
          STT_PROVIDER: 'sarvam',
        }),
      /SARVAM_API_KEY/,
    );
  });

  it('rejects unknown providers', () => {
    const base = {
      OPENROUTER_API_KEY: 'o',
      TWILIO_ACCOUNT_SID: 'ACx',
      TWILIO_AUTH_TOKEN: 't',
      GROQ_API_KEY: 'g',
      STREAM_WS_URL: 'wss://example.com/stream',
    };
    assert.throws(() => loadConfig({ ...base, STT_PROVIDER: 'deepgram' }), /STT_PROVIDER/);
    assert.throws(() => loadConfig({ ...base, TTS_PROVIDER: 'elevenlabs' }), /TTS_PROVIDER/);
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
          SARVAM_API_KEY: 'sk-sarvam',
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
        location: 'Bobby Clinic',
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
