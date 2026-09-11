import type { AppointmentsEnv } from './appointments.ts';
import type { SttConfig } from './whisper.ts';

const STT_PROVIDER_DEFAULTS = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3' },
} as const;

type WhisperProvider = keyof typeof STT_PROVIDER_DEFAULTS;

export type SttProvider = WhisperProvider | 'sarvam';
export type TtsProvider = 'openai' | 'sarvam';

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
  sttModel: string;
  sttLanguageCode: string;
  sttMode: string;
  ttsModel: string;
  ttsSpeaker: string;
  ttsLanguageCode: string;
  ttsSampleRate: number;
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
  endpointSilenceMs: number;
  endpointMinSpeechMs: number;
  endpointMaxUtteranceMs: number;
  vadThreshold: number;
  endpointLatchDipMs: number;  vadModelPath: string;
  /** Speak a holding line when a Turn phase runs long; <=0 disables holds. */
  speakHoldMs: number;
  /** Overall deadline for one Availability read; <=0 waits forever. */
  appointmentsWaitMs: number;
  twilioAccountSid: string;
  twilioAuthToken: string;
  /** Which transcription provider the server constructs. */
  sttProvider: SttProvider;
  /** Which speech provider the server constructs. */
  ttsProvider: TtsProvider;
  stt: SttConfig;
  tts: TtsEnv;
  sarvam: SarvamEnv;
  /** Picktime Tool API the assistant reads Availability from and books through. */
  appointments: AppointmentsEnv;
  llmApiKey: string;
  openrouterModel: string;
  /** Sampling temperature for the assistant; a little warmer = more conversational. */
  openrouterTemperature: number;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing: string[] = [];
  const twilioAccountSid = required(env, 'TWILIO_ACCOUNT_SID', missing);
  const twilioAuthToken = required(env, 'TWILIO_AUTH_TOKEN', missing);
  const sttProviderRaw = env.STT_PROVIDER;
  if (sttProviderRaw !== undefined && sttProviderRaw !== 'openai' && sttProviderRaw !== 'groq' && sttProviderRaw !== 'sarvam') {
    throw new Error(`invalid STT_PROVIDER: ${sttProviderRaw} (expected openai|groq|sarvam)`);
  }
  // Either Whisper-compatible key works: OpenAI is the researched default,
  // Groq serves the same shape for whisper-large models. An explicit
  // STT_PROVIDER always wins; Sarvam has its own key.
  const sttProvider: SttProvider =
    sttProviderRaw ?? (env.OPENAI_API_KEY === undefined && env.GROQ_API_KEY !== undefined ? 'groq' : 'openai');
  const sttApiKey = env.OPENAI_API_KEY ?? env.GROQ_API_KEY ?? '';
  if (sttProvider !== 'sarvam' && !sttApiKey) missing.push('OPENAI_API_KEY or GROQ_API_KEY');
  const ttsProviderRaw = optional(env, 'TTS_PROVIDER', 'openai');
  if (ttsProviderRaw !== 'openai' && ttsProviderRaw !== 'sarvam') {
    throw new Error(`invalid TTS_PROVIDER: ${ttsProviderRaw} (expected openai|sarvam)`);
  }
  const ttsProvider: TtsProvider = ttsProviderRaw;
  const sarvamApiKey = env.SARVAM_API_KEY ?? '';
  if ((sttProvider === 'sarvam' || ttsProvider === 'sarvam') && !sarvamApiKey) {
    missing.push('SARVAM_API_KEY');
  }
  const llmApiKey = required(env, 'OPENROUTER_API_KEY', missing);
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
  // Groq defaults apply only when the Groq key is the sole STT key; an
  // explicit OPENAI_API_KEY (or WHISPER_* overrides below) always wins.
  const whisperProvider: WhisperProvider = sttProvider === 'groq' ? 'groq' : 'openai';
  const defaults = STT_PROVIDER_DEFAULTS[whisperProvider];
  const ttsResponseFormatRaw = optional(env, 'TTS_RESPONSE_FORMAT', 'pcm');
  if (ttsResponseFormatRaw !== 'wav' && ttsResponseFormatRaw !== 'pcm') {
    throw new Error(`invalid TTS_RESPONSE_FORMAT: ${ttsResponseFormatRaw} (expected wav|pcm)`);
  }
  const appointmentsWindowDays = int(env, 'APPOINTMENTS_WINDOW_DAYS', 14);
  if (appointmentsWindowDays < 1 || appointmentsWindowDays > 31) {
    throw new Error(`invalid APPOINTMENTS_WINDOW_DAYS: ${appointmentsWindowDays} (expected 1-31)`);
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
    endpointSilenceMs: int(env, 'ENDPOINT_SILENCE_MS', 700),
    endpointMinSpeechMs: int(env, 'ENDPOINT_MIN_SPEECH_MS', 300),
    endpointMaxUtteranceMs: int(env, 'ENDPOINT_MAX_UTTERANCE_MS', 30000),
    vadThreshold: float(env, 'VAD_SPEECH_THRESHOLD', 0.1),
    endpointLatchDipMs: int(env, 'ENDPOINT_LATCH_DIP_MS', 200),
    vadModelPath: optional(env, 'VAD_MODEL_PATH', './models/silero_vad.onnx'),
    speakHoldMs: int(env, 'SPEAK_HOLD_MS', 3000),
    appointmentsWaitMs: int(env, 'APPOINTMENTS_WAIT_MS', 10000),
    twilioAccountSid,
    twilioAuthToken,
    sttProvider,
    ttsProvider,
    stt: {
      apiKey: sttApiKey,
      baseUrl: optional(env, 'WHISPER_BASE_URL', defaults.baseUrl),
      model: optional(env, 'WHISPER_MODEL', defaults.model),
    },
    appointments: {
      baseUrl: optional(env, 'APPOINTMENTS_API_URL', 'https://receptionist-3r3d.onrender.com'),
      windowDays: appointmentsWindowDays,
    },
    sarvam: {
      apiKey: sarvamApiKey,
      baseUrl: optional(env, 'SARVAM_BASE_URL', 'https://api.sarvam.ai'),
      sttModel: optional(env, 'SARVAM_STT_MODEL', 'saaras:v3'),
      sttLanguageCode: optional(env, 'SARVAM_STT_LANGUAGE', 'en-IN'),
      sttMode: optional(env, 'SARVAM_STT_MODE', 'transcribe'),
      ttsModel: optional(env, 'SARVAM_TTS_MODEL', 'bulbul:v3'),
      ttsSpeaker: optional(env, 'SARVAM_TTS_SPEAKER', 'shubh'),
      ttsLanguageCode: optional(env, 'SARVAM_TTS_LANGUAGE', 'en-IN'),
      ttsSampleRate: int(env, 'SARVAM_TTS_SAMPLE_RATE', 8000),
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
    openrouterModel: optional(env, 'OPENROUTER_MODEL', 'deepseek/deepseek-v4-flash-0731'),
    openrouterTemperature: float(env, 'OPENROUTER_TEMPERATURE', 0.4),
  };
}
