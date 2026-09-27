import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';
import { formatFailureLine } from '../src/log.ts';
import type { FailureEvent } from '../src/app.ts';

describe('config', () => {
  it('fails fast listing every missing credential', () => {
    assert.throws(() => loadConfig({}), /OPENAI_API_KEY.*OPENROUTER_API_KEY|OPENROUTER_API_KEY.*OPENAI_API_KEY/);
  });

  it('defaults STT to OpenAI realtime, requiring the OpenAI key', () => {
    const cfg = loadConfig({
      OPENAI_API_KEY: 'sk-openai',
      OPENROUTER_API_KEY: 'o',
      TWILIO_ACCOUNT_SID: 'ACx',
      TWILIO_AUTH_TOKEN: 't',
      STREAM_WS_URL: 'wss://example.com/stream',
    });
    assert.equal(cfg.sttProvider, 'openai-realtime');
    assert.equal(cfg.openaiRealtime.model, 'gpt-live-transcribe');
    assert.throws(
      () =>
        loadConfig({
          OPENROUTER_API_KEY: 'o',
          TWILIO_ACCOUNT_SID: 'ACx',
          TWILIO_AUTH_TOKEN: 't',
          STREAM_WS_URL: 'wss://example.com/stream',
        }),
      /OPENAI_API_KEY/,
    );
  });

  it('prefers explicit whisper overrides when the provider is selected', () => {
    const cfg = loadConfig({
      GROQ_API_KEY: 'g',
      OPENAI_API_KEY: 'sk-openai',
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

  it('selects Sarvam for TTS without a Whisper key', () => {
    const cfg = loadConfig({
      OPENAI_API_KEY: 'sk-openai',
      OPENROUTER_API_KEY: 'o',
      TWILIO_ACCOUNT_SID: 'ACx',
      TWILIO_AUTH_TOKEN: 't',
      STREAM_WS_URL: 'wss://example.com/stream',
      SARVAM_API_KEY: 'sk-sarvam',
      TTS_PROVIDER: 'sarvam',
    });
    assert.equal(cfg.sttProvider, 'openai-realtime');
    assert.equal(cfg.ttsProvider, 'sarvam');
    assert.equal(cfg.sarvam.apiKey, 'sk-sarvam');
    assert.equal(cfg.sarvam.baseUrl, 'https://api.sarvam.ai');
    assert.equal(cfg.sarvam.ttsModel, 'bulbul:v3');
    assert.equal(cfg.sarvam.ttsSpeaker, 'shubh');
    assert.equal(cfg.sarvam.ttsSampleRate, 8000);
  });

  it('defaults Sarvam streaming TTS on, overridable', () => {
    const base = {
      OPENAI_API_KEY: 'sk-openai',
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
      OPENAI_API_KEY: 'sk-openai',
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

  it('defaults the Sarvam TTS text buffer to the provider floor, clamped', () => {
    const base = {
      OPENAI_API_KEY: 'sk-openai',
      OPENROUTER_API_KEY: 'o',
      TWILIO_ACCOUNT_SID: 'ACx',
      TWILIO_AUTH_TOKEN: 't',
      STREAM_WS_URL: 'wss://example.com/stream',
      SARVAM_API_KEY: 'sk-sarvam',
    };
    assert.equal(loadConfig(base).sarvam.ttsMinBufferSize, 30);
    assert.equal(loadConfig({ ...base, SARVAM_TTS_MIN_BUFFER_SIZE: '50' }).sarvam.ttsMinBufferSize, 50);
    // The provider rejects values below 30 with a 422; clamp so a tuned value
    // can never take down every reply on the call.
    assert.equal(loadConfig({ ...base, SARVAM_TTS_MIN_BUFFER_SIZE: '10' }).sarvam.ttsMinBufferSize, 30);
  });

  it('selects OpenAI Realtime transcription when asked, requiring its key', () => {
    const base = {
      OPENAI_API_KEY: 'sk-openai',
      OPENROUTER_API_KEY: 'o',
      TWILIO_ACCOUNT_SID: 'ACx',
      TWILIO_AUTH_TOKEN: 't',
      STREAM_WS_URL: 'wss://example.com/stream',
      SARVAM_API_KEY: 'sk-sarvam',
    };
    const cfg = loadConfig({ ...base, STT_PROVIDER: 'openai-realtime', OPENAI_API_KEY: 'sk-openai' });
    assert.equal(cfg.sttProvider, 'openai-realtime');
    assert.equal(cfg.openaiRealtime.apiKey, 'sk-openai');
    assert.equal(cfg.openaiRealtime.model, 'gpt-live-transcribe');
    assert.equal(cfg.openaiRealtime.delay, 'low');
    assert.equal(cfg.openaiRealtime.url, 'wss://api.openai.com/v1/realtime?intent=transcription');
    assert.deepEqual(cfg.openaiRealtime.languages, ['en']);
    assert.throws(
      () => loadConfig({ ...base, STT_PROVIDER: 'openai-realtime', OPENAI_API_KEY: undefined }),
      /OPENAI_API_KEY/,
    );
    assert.throws(
      () => loadConfig({ ...base, STT_PROVIDER: 'openai-realtime', OPENAI_API_KEY: 'k', OPENAI_REALTIME_DELAY: 'warp' }),
      /OPENAI_REALTIME_DELAY/,
    );
  });

  it('warms the REST STT route by default, overridable', () => {
    const base = {
      OPENAI_API_KEY: 'sk-openai',
      OPENROUTER_API_KEY: 'o',
      TWILIO_ACCOUNT_SID: 'ACx',
      TWILIO_AUTH_TOKEN: 't',
      STREAM_WS_URL: 'wss://example.com/stream',
      SARVAM_API_KEY: 'sk-sarvam',
    };
    assert.equal(loadConfig(base).sttWarmup, true);
    assert.equal(loadConfig({ ...base, STT_WARMUP: 'false' }).sttWarmup, false);
  });

  it('defaults the assistant to Groq gpt-oss-120b with the OpenRouter model as fallback', () => {
    const base = {
      OPENAI_API_KEY: 'sk-openai',
      OPENROUTER_API_KEY: 'o',
      TWILIO_ACCOUNT_SID: 'ACx',
      TWILIO_AUTH_TOKEN: 't',
      STREAM_WS_URL: 'wss://example.com/stream',
      SARVAM_API_KEY: 'sk-sarvam',
    };
    const withGroq = loadConfig({ ...base, GROQ_API_KEY: 'g' });
    assert.equal(withGroq.assistant.primary, 'groq');
    assert.equal(withGroq.assistant.groqModel, 'openai/gpt-oss-120b');
    assert.equal(withGroq.assistant.groqBaseUrl, 'https://api.groq.com/openai/v1');
    assert.equal(withGroq.assistant.groqReasoningEffort, 'low');
    assert.equal(withGroq.openrouterModel, 'deepseek/deepseek-v4.1-flash');
    assert.equal(
      loadConfig({ ...base, GROQ_API_KEY: 'g', GROQ_ASSISTANT_MODEL: 'openai/gpt-oss-20b' }).assistant.groqModel,
      'openai/gpt-oss-20b',
    );
    // No Groq key: the OpenRouter model is the only assistant.
    assert.equal(loadConfig(base).assistant.primary, 'openrouter');
    assert.equal(
      loadConfig({ ...base, GROQ_API_KEY: 'g', ASSISTANT_PROVIDER: 'openrouter' }).assistant.primary,
      'openrouter',
    );
    assert.throws(() => loadConfig({ ...base, ASSISTANT_PROVIDER: 'groq' }), /GROQ_API_KEY/);
    assert.throws(
      () => loadConfig({ ...base, GROQ_API_KEY: 'g', ASSISTANT_PROVIDER: 'anthropic' }),
      /ASSISTANT_PROVIDER/,
    );
  });

  it('selects OpenRouter STT as the primary transcriber, overridable', () => {
    const base = {
      OPENAI_API_KEY: 'sk-openai',
      OPENROUTER_API_KEY: 'o',
      TWILIO_ACCOUNT_SID: 'ACx',
      TWILIO_AUTH_TOKEN: 't',
      STREAM_WS_URL: 'wss://example.com/stream',
    };
    const cfg = loadConfig({ ...base, STT_PROVIDER: 'openrouter' });
    assert.equal(cfg.sttProvider, 'openrouter');
    assert.equal(cfg.openrouterSttModel, 'openai/gpt-transcribe');
    const tuned = loadConfig({
      ...base,
      STT_PROVIDER: 'openrouter',
      OPENROUTER_STT_MODEL: 'openai/gpt-4o-mini-transcribe',
    });
    assert.equal(tuned.openrouterSttModel, 'openai/gpt-4o-mini-transcribe');
  });

  it('no longer carries the fixed silence and max-utterance knobs', () => {
    const cfg = loadConfig({
      OPENAI_API_KEY: 'sk-openai',
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

  it('names the Barge-in candidate knobs and drops the Barge-in boolean', () => {
    const base = {
      OPENAI_API_KEY: 'sk-openai',
      OPENROUTER_API_KEY: 'o',
      TWILIO_ACCOUNT_SID: 'ACx',
      TWILIO_AUTH_TOKEN: 't',
      STREAM_WS_URL: 'wss://example.com/stream',
      SARVAM_API_KEY: 'sk-sarvam',
      BARGE_IN: 'true',
      BARGE_IN_SPEECH_MS: '250',
      ENDPOINT_MIN_SPEECH_MS: '300',
      ENDPOINT_LATCH_DIP_MS: '200',
    };
    const cfg = loadConfig(base);
    assert.equal(Object.hasOwn(cfg, 'bargeIn'), false, 'Barge-in is always on');
    assert.equal(Object.hasOwn(cfg, 'bargeInSpeechMs'), false);
    assert.equal(Object.hasOwn(cfg, 'endpointMinSpeechMs'), false);
    assert.equal(Object.hasOwn(cfg, 'endpointLatchDipMs'), false);
    assert.equal(cfg.bargeInMinSpeechMs, 200);
    assert.equal(cfg.bargeInDipToleranceMs, 200);
    assert.equal(cfg.bargeInConfirmMs, 300);
    const tuned = loadConfig({
      ...base,
      BARGE_IN_MIN_SPEECH_MS: '150',
      BARGE_IN_DIP_TOLERANCE_MS: '120',
      BARGE_IN_CONFIRM_MS: '250',
    });
    assert.equal(tuned.bargeInMinSpeechMs, 150);
    assert.equal(tuned.bargeInDipToleranceMs, 120);
    assert.equal(tuned.bargeInConfirmMs, 250);
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
      OPENAI_API_KEY: 'sk-openai',
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
      OPENAI_API_KEY: 'sk-openai',
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
      OPENAI_API_KEY: 'sk-openai',
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

  it('rejects Sarvam STT and requires SARVAM_API_KEY only for Sarvam TTS', () => {
    const base = {
      OPENAI_API_KEY: 'sk-openai',
      OPENROUTER_API_KEY: 'o',
      TWILIO_ACCOUNT_SID: 'ACx',
      TWILIO_AUTH_TOKEN: 't',
      STREAM_WS_URL: 'wss://example.com/stream',
    };
    assert.throws(
      () => loadConfig({ ...base, STT_PROVIDER: 'sarvam' }),
      /invalid STT_PROVIDER: sarvam \(expected openai\|groq\|openrouter\|openai-realtime\)/,
    );
    assert.equal(loadConfig(base).sttProvider, 'openai-realtime', 'STT never needs a Sarvam key');
    assert.throws(() => loadConfig({ ...base, TTS_PROVIDER: 'sarvam' }), /SARVAM_API_KEY/);
    assert.doesNotThrow(() => loadConfig({ ...base, TTS_PROVIDER: 'sarvam', SARVAM_API_KEY: 'sk-sarvam' }));
  });

  it('rejects unknown providers', () => {
    const base = {
      OPENAI_API_KEY: 'sk-openai',
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
          OPENAI_API_KEY: 'sk-openai',
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
