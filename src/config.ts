import type { AppointmentsEnv } from './appointments.ts';
import { BARGE_IN_DEFAULTS } from './endpoint.ts';
import type { SttConfig } from './whisper.ts';

const STT_PROVIDER_DEFAULTS = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3' },
} as const;

type WhisperProvider = keyof typeof STT_PROVIDER_DEFAULTS;

export type SttProvider = WhisperProvider | 'openrouter' | 'openai-realtime';
export type TtsProvider = 'openai' | 'sarvam';
export type AssistantProvider = 'groq' | 'openrouter';

export interface OpenAiRealtimeEnv {
  apiKey: string;
  /** Transcription websocket URL; the `intent=transcription` session. */
  url: string;
  model: string;
  /** Latency/accuracy tradeoff: `minimal` | `low` | `medium` | `high` | `xhigh`. */
  delay: string;
  languages: string[];
}

export interface AssistantEnv {
  /** Primary assistant provider; `groq` only when a Groq key is configured. */
  primary: AssistantProvider;
  groqApiKey: string;
  groqBaseUrl: string;
  groqModel: string;
  /** Groq reasoning is low/medium/high; `minimal`/`none` map to `low`. */
  groqReasoningEffort: 'low' | 'medium' | 'high';
}

export type VoiceLoop = 'legacy' | 'stream';

export interface TtsEnv {
  apiKey: string;
  baseUrl: string;
  model: string;
  voice: string;
  responseFormat: 'wav' | 'pcm';
  pcmSampleRate: number;
}

export interface SarvamEnv {
  apiKey: string;
  baseUrl: string;
  ttsModel: string;
  ttsSpeaker: string;
  ttsLanguageCode: string;
  ttsSampleRate: number;
  /** Stream TTS over Sarvam's text-to-speech WebSocket instead of the REST call. */
  ttsStream: boolean;
  /** How long a streamed utterance may go silent before the REST fallback takes over. */
  ttsStreamIdleTimeoutMs: number;
  /** Provider text buffering before streaming synthesis starts. */
  ttsMinBufferSize?: number;
  /** Provider sentence-splitting ceiling for streamed text. */
  ttsMaxChunkLength?: number;
}

export interface Config {
  port: number;
  guidePath: string;
  sayVoice: string;
  sayLanguage: string;
  recordTimeout: number;
  recordMaxLength: number;
  voiceLoop: VoiceLoop;
  streamWsUrl: string;
  /** Warm the REST transcription route on call open to hide provider cold start. */
  sttWarmup: boolean;
  vadThreshold: number;
  /** Echo gate: correlation needed to classify an inbound frame as Echo. */
  echoGateCorrelation: number;
  /** Echo gate: dB above the learned return level that counts as Caller double-talk. */
  echoGateLevelMarginDb: number;
  /** Echo gate: longest Echo return delay the correlation search considers. */
  echoGateMaxDelayMs: number;
  vadModelPath: string;
  /** Speak a holding line when a Turn phase runs long; <=0 disables holds. */
  speakHoldMs: number;
  /** Silence after the Receptionist stops speaking before it asks again; <=0 disables. */
  noResponseMs: number;
  /** Overall deadline for one Availability read; <=0 waits forever. */
  appointmentsWaitMs: number;
  /** Sustained non-Echo Caller speech before a Barge-in fires. */
  bargeInMinSpeechMs: number;
  /** Sub-threshold dip a Barge-in candidate tolerates before resetting. */
  bargeInDipToleranceMs: number;
  /** Wait past the pre-trigger for a partial to classify a Backchannel. */
  bargeInConfirmMs: number;
  /** Whole-Turn deadline for the LLM response; <=0 disables. */
  turnDeadlineMs: number;
  /** Bound on one Turn's REST transcription decodes (hedge, retry, second opinion); <=0 waits forever. */
  sttDeadlineMs: number;
  /** Shared fixed-phrase cache directory; unset means in-memory only. */
  fixedAudioCacheDir?: string;
  /** Best-effort prewarm budget before the server starts accepting calls. */
  fixedPrewarmMs: number;
  /** Selective OpenRouter STT second decode for critical fields. */
  openrouterSttFallback: boolean;
  /** Primary model when `sttProvider` is `openrouter`; second opinion otherwise. */
  openrouterSttModel: string;
  twilioAccountSid: string;
  twilioAuthToken: string;
  /** Which transcription provider the server constructs. */
  sttProvider: SttProvider;
  /** Which speech provider the server constructs. */
  ttsProvider: TtsProvider;
  stt: SttConfig;
  openaiRealtime: OpenAiRealtimeEnv;
  tts: TtsEnv;
  sarvam: SarvamEnv;
  /** Picktime Tool API the assistant reads Availability from and books through. */
  appointments: AppointmentsEnv;
  /** Clone REST API a flipped Location books through (spec §10 parallel run). */
  cloneBookings: { baseUrl: string };
  llmApiKey: string;
  /** Assistant primary/fallback routing: Groq gpt-oss first, OpenRouter fallback. */
  assistant: AssistantEnv;
  openrouterModel: string;
  /** Sampling temperature for the assistant; a little warmer = more conversational. */
  openrouterTemperature: number;
  /**
   * Reasoning effort for the assistant LLM. Reasoning-mandatory endpoints
   * (gpt-5-nano, gpt-oss) refuse `none`; `minimal` keeps TTFT low everywhere.
   */
  openrouterReasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  /** Debug-only: when set, each utterance WAV is written here before transcription. */
  debugAudioDir?: string;
}

function required(env: NodeJS.ProcessEnv, name: string, missing: string[]): string {
  const value = env[name];
  if (!value) {
    missing.push(name);
    return '';
  }
  return value;
}

function optional(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  return env[name] ?? fallback;
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number, parse: (raw: string) => number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const parsed = parse(raw);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  return num(env, name, fallback, (raw) => Number.parseInt(raw, 10));
}

function float(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  return num(env, name, fallback, (raw) => Number.parseFloat(raw));
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined) return fallback;
  return raw === 'true' || raw === '1';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing: string[] = [];
  const twilioAccountSid = required(env, 'TWILIO_ACCOUNT_SID', missing);
  const twilioAuthToken = required(env, 'TWILIO_AUTH_TOKEN', missing);
  const sttProviderRaw = env.STT_PROVIDER;
  if (
    sttProviderRaw !== undefined &&
    sttProviderRaw !== 'openai' &&
    sttProviderRaw !== 'groq' &&
    sttProviderRaw !== 'openrouter' &&
    sttProviderRaw !== 'openai-realtime'
  ) {
    throw new Error(`invalid STT_PROVIDER: ${sttProviderRaw} (expected openai|groq|openrouter|openai-realtime)`);
  }
  // OpenAI's realtime transcription channel is the default; the
  // Whisper-compatible providers stay selectable (openai|groq) and need
  // OPENAI_API_KEY or GROQ_API_KEY. `openrouter` uses the OpenRouter
  // transcriptions endpoint (per-utterance REST, no realtime channel) with the
  // always-required OPENROUTER_API_KEY.
  const sttProvider: SttProvider = sttProviderRaw ?? 'openai-realtime';
  const openaiApiKey = env.OPENAI_API_KEY ?? '';
  const sttApiKey =
    sttProvider === 'openai' || sttProvider === 'openai-realtime'
      ? openaiApiKey
      : sttProvider === 'groq'
        ? (env.GROQ_API_KEY ?? '')
        : '';
  if ((sttProvider === 'openai' || sttProvider === 'openai-realtime') && !sttApiKey) missing.push('OPENAI_API_KEY');
  if (sttProvider === 'groq' && !sttApiKey) missing.push('GROQ_API_KEY');
  const ttsProviderRaw = optional(env, 'TTS_PROVIDER', 'openai');
  if (ttsProviderRaw !== 'openai' && ttsProviderRaw !== 'sarvam') {
    throw new Error(`invalid TTS_PROVIDER: ${ttsProviderRaw} (expected openai|sarvam)`);
  }
  const ttsProvider: TtsProvider = ttsProviderRaw;
  const sarvamApiKey = env.SARVAM_API_KEY ?? '';
  // Sarvam is TTS-only: its key is required only when Sarvam speech is selected.
  if (ttsProvider === 'sarvam' && !sarvamApiKey) {
    missing.push('SARVAM_API_KEY');
  }
  const llmApiKey = required(env, 'OPENROUTER_API_KEY', missing);
  const groqApiKey = env.GROQ_API_KEY ?? '';
  const assistantProviderRaw = optional(env, 'ASSISTANT_PROVIDER', groqApiKey ? 'groq' : 'openrouter');
  if (assistantProviderRaw !== 'groq' && assistantProviderRaw !== 'openrouter') {
    throw new Error(`invalid ASSISTANT_PROVIDER: ${assistantProviderRaw} (expected groq|openrouter)`);
  }
  if (assistantProviderRaw === 'groq' && !groqApiKey) missing.push('GROQ_API_KEY');
  const groqReasoningRaw = optional(env, 'GROQ_ASSISTANT_REASONING_EFFORT', 'low');
  if (groqReasoningRaw !== 'low' && groqReasoningRaw !== 'medium' && groqReasoningRaw !== 'high') {
    throw new Error(`invalid GROQ_ASSISTANT_REASONING_EFFORT: ${groqReasoningRaw} (expected low|medium|high)`);
  }
  const voiceLoopRaw = optional(env, 'VOICE_LOOP', 'stream');
  if (voiceLoopRaw !== 'legacy' && voiceLoopRaw !== 'stream') {
    throw new Error(`invalid VOICE_LOOP: ${voiceLoopRaw} (expected legacy|stream)`);
  }
  const voiceLoop: VoiceLoop = voiceLoopRaw;
  const streamWsUrl =
    voiceLoop === 'stream' ? required(env, 'STREAM_WS_URL', missing) : optional(env, 'STREAM_WS_URL', '');
  if (missing.length > 0) throw new Error(`missing required env: ${missing.join(', ')}`);
  if (voiceLoop === 'stream' && !streamWsUrl.startsWith('wss://')) {
    throw new Error(`invalid STREAM_WS_URL: ${streamWsUrl} (expected a public wss:// URL for the Connect TwiML)`);
  }
  const whisperProvider: WhisperProvider = sttProvider === 'groq' ? 'groq' : 'openai';
  const defaults = STT_PROVIDER_DEFAULTS[whisperProvider];
  const ttsResponseFormatRaw = optional(env, 'TTS_RESPONSE_FORMAT', 'pcm');
  if (ttsResponseFormatRaw !== 'wav' && ttsResponseFormatRaw !== 'pcm') {
    throw new Error(`invalid TTS_RESPONSE_FORMAT: ${ttsResponseFormatRaw} (expected wav|pcm)`);
  }
  // `low` keeps punctuation that `minimal` drops, for ~30 ms more latency.
  const openaiRealtimeDelay = optional(env, 'OPENAI_REALTIME_DELAY', 'low');
  if (!['minimal', 'low', 'medium', 'high', 'xhigh'].includes(openaiRealtimeDelay)) {
    throw new Error(`invalid OPENAI_REALTIME_DELAY: ${openaiRealtimeDelay} (expected minimal|low|medium|high|xhigh)`);
  }
  // Working days span more calendar days than they count (5 wd ≈ 7 days), so
  // cap the config below the Tool API's 31-calendar-day window limit.
  const appointmentsWindowWorkingDays = int(env, 'APPOINTMENTS_WINDOW_WORKING_DAYS', 5);
  if (appointmentsWindowWorkingDays < 1 || appointmentsWindowWorkingDays > 21) {
    throw new Error(`invalid APPOINTMENTS_WINDOW_WORKING_DAYS: ${appointmentsWindowWorkingDays} (expected 1-21)`);
  }
  return {
    port: int(env, 'PORT', 3000),
    guidePath: optional(env, 'CLINIC_GUIDE_PATH', './clinic.md'),
    sayVoice: optional(env, 'SAY_VOICE', 'alice'),
    sayLanguage: optional(env, 'SAY_LANGUAGE', 'en-IN'),
    recordTimeout: int(env, 'RECORD_TIMEOUT', 5),
    recordMaxLength: int(env, 'RECORD_MAX_LENGTH', 30),
    voiceLoop,
    streamWsUrl,
    sttWarmup: bool(env, 'STT_WARMUP', true),
    vadThreshold: float(env, 'VAD_SPEECH_THRESHOLD', 0.1),
    echoGateCorrelation: float(env, 'ECHO_GATE_CORRELATION', 0.7),
    echoGateLevelMarginDb: float(env, 'ECHO_GATE_LEVEL_MARGIN_DB', 6),
    echoGateMaxDelayMs: int(env, 'ECHO_GATE_MAX_DELAY_MS', 600),
    vadModelPath: optional(env, 'VAD_MODEL_PATH', './models/silero_vad.onnx'),
    speakHoldMs: int(env, 'SPEAK_HOLD_MS', 3000),
    noResponseMs: int(env, 'NO_RESPONSE_MS', 8000),
    appointmentsWaitMs: int(env, 'APPOINTMENTS_WAIT_MS', 10000),
    bargeInMinSpeechMs: int(env, 'BARGE_IN_MIN_SPEECH_MS', BARGE_IN_DEFAULTS.minSpeechMs),
    bargeInDipToleranceMs: int(env, 'BARGE_IN_DIP_TOLERANCE_MS', BARGE_IN_DEFAULTS.dipToleranceMs),
    bargeInConfirmMs: int(env, 'BARGE_IN_CONFIRM_MS', BARGE_IN_DEFAULTS.confirmMs),
    turnDeadlineMs: int(env, 'TURN_DEADLINE_MS', 6000),
    sttDeadlineMs: int(env, 'STT_DEADLINE_MS', 5000),
    fixedAudioCacheDir: env.FIXED_AUDIO_CACHE_DIR,
    fixedPrewarmMs: int(env, 'FIXED_AUDIO_PREWARM_MS', 8000),
    openrouterSttFallback: bool(env, 'OPENROUTER_STT_FALLBACK', false),
    openrouterSttModel: optional(env, 'OPENROUTER_STT_MODEL', 'openai/gpt-transcribe'),
    twilioAccountSid,
    twilioAuthToken,
    sttProvider,
    ttsProvider,
    stt: {
      apiKey: sttApiKey,
      baseUrl: optional(env, 'WHISPER_BASE_URL', defaults.baseUrl),
      model: optional(env, 'WHISPER_MODEL', defaults.model),
    },
    openaiRealtime: {
      apiKey: openaiApiKey,
      url: optional(env, 'OPENAI_REALTIME_URL', 'wss://api.openai.com/v1/realtime?intent=transcription'),
      model: optional(env, 'OPENAI_REALTIME_MODEL', 'gpt-live-transcribe'),
      delay: openaiRealtimeDelay,
      languages: optional(env, 'OPENAI_REALTIME_LANGUAGES', 'en')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    },
    appointments: {
      baseUrl: optional(env, 'APPOINTMENTS_API_URL', 'https://receptionist-3r3d.onrender.com'),
      windowWorkingDays: appointmentsWindowWorkingDays,
    },
    cloneBookings: {
      baseUrl: optional(env, 'BOOKING_API_URL', 'http://127.0.0.1:3101'),
    },
    sarvam: {
      apiKey: sarvamApiKey,
      baseUrl: optional(env, 'SARVAM_BASE_URL', 'https://api.sarvam.ai'),
      ttsModel: optional(env, 'SARVAM_TTS_MODEL', 'bulbul:v3'),
      ttsSpeaker: optional(env, 'SARVAM_TTS_SPEAKER', 'shubh'),
      ttsLanguageCode: optional(env, 'SARVAM_TTS_LANGUAGE', 'en-IN'),
      ttsSampleRate: int(env, 'SARVAM_TTS_SAMPLE_RATE', 8000),
      ttsStream: bool(env, 'SARVAM_TTS_STREAM', true),
      ttsStreamIdleTimeoutMs: int(env, 'SARVAM_TTS_STREAM_IDLE_TIMEOUT_MS', 5000),
      // Sarvam rejects min_buffer_size below 30 with a 422 and closes the
      // stream, which would take down every reply on a call. Clamp at the
      // provider floor; the session's voice chunker stays the buffering policy.
      ttsMinBufferSize: Math.max(30, int(env, 'SARVAM_TTS_MIN_BUFFER_SIZE', 30)),
      ttsMaxChunkLength: int(env, 'SARVAM_TTS_MAX_CHUNK_LENGTH', 150),
    },
    tts: {
      // TTS rides on OpenRouter itself: dedicated key wins, else the required
      // OpenRouter key, else the legacy OpenAI/STT key for an OpenAI base URL.
      apiKey: env.TTS_API_KEY ?? env.OPENROUTER_API_KEY ?? sttApiKey,
      baseUrl: optional(env, 'TTS_BASE_URL', 'https://openrouter.ai/api/v1'),
      model: optional(env, 'TTS_MODEL', 'qwen/qwen-audio-3.0-tts-flash'),
      voice: optional(env, 'TTS_VOICE', 'loongjohn'),
      responseFormat: ttsResponseFormatRaw,
      pcmSampleRate: int(env, 'TTS_PCM_SAMPLE_RATE', 24000),
    },
    llmApiKey,
    assistant: {
      primary: assistantProviderRaw,
      groqApiKey,
      groqBaseUrl: optional(env, 'GROQ_ASSISTANT_BASE_URL', 'https://api.groq.com/openai/v1'),
      groqModel: optional(env, 'GROQ_ASSISTANT_MODEL', 'openai/gpt-oss-120b'),
      groqReasoningEffort: groqReasoningRaw,
    },
    openrouterModel: optional(env, 'OPENROUTER_MODEL', 'deepseek/deepseek-v4.1-flash'),
    openrouterTemperature: float(env, 'OPENROUTER_TEMPERATURE', 0.4),
    openrouterReasoningEffort: ((): Config['openrouterReasoningEffort'] => {
      const raw = optional(env, 'OPENROUTER_REASONING_EFFORT', 'minimal');
      return raw === 'none' || raw === 'low' || raw === 'medium' || raw === 'high'
        ? raw
        : 'minimal';
    })(),
    debugAudioDir: env.DEBUG_AUDIO_DIR,
  };
}
