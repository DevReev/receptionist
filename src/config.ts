import type { AppointmentsEnv } from './appointments.ts';
import { BARGE_IN_DEFAULTS } from './endpoint.ts';
import type { TurnDetection } from './turnTaking.ts';
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
  /** Use the Realtime WebSocket for live calls instead of per-utterance REST. */
  sttRealtime: boolean;
  sttRealtimeModel: string;
  sttStreamType: string;
  /** Terminology hint sent with the realtime connection; derived from the guide when unset. */
  sttPrompt?: string;
  /** How long a Turn waits for `transcript.final` before falling back to REST. */
  sttFinalTimeoutMs: number;
  /** Provider VAD sensitivity (0.0-1.0); provider default 0.3. */
  sttVadThreshold: number;
  /** Provider VAD silence in ms marking end-of-turn; provider default 500. */
  sttVadSilenceMs: number;
  /** Provider VAD minimum speech in ms to count as an utterance; provider default 250. */
  sttVadMinSpeechMs: number;
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
  /** Boundary authority: `sarvam` (provider VAD, default) or `hybrid` (local detector). */
  turnDetection: TurnDetection;
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
  /** Whole-Turn deadline for the LLM response; <=0 disables. */
  turnDeadlineMs: number;
  /** Shared fixed-phrase cache directory; unset means in-memory only. */
  fixedAudioCacheDir?: string;
  /** Best-effort prewarm budget before the server starts accepting calls. */
  fixedPrewarmMs: number;
  /** Selective OpenRouter STT second decode for critical fields. */
  openrouterSttFallback: boolean;
  openrouterSttModel: string;
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
  if (sttProviderRaw !== undefined && sttProviderRaw !== 'openai' && sttProviderRaw !== 'groq' && sttProviderRaw !== 'sarvam') {
    throw new Error(`invalid STT_PROVIDER: ${sttProviderRaw} (expected openai|groq|sarvam)`);
  }
  // Sarvam is the default transcriber; an explicit STT_PROVIDER always wins.
  // The Whisper-compatible providers stay selectable (openai|groq) and need
  // OPENAI_API_KEY or GROQ_API_KEY.
  const sttProvider: SttProvider = sttProviderRaw ?? 'sarvam';
  const sttApiKey =
    sttProvider === 'openai' ? (env.OPENAI_API_KEY ?? '') : sttProvider === 'groq' ? (env.GROQ_API_KEY ?? '') : '';
  if (sttProvider === 'openai' && !sttApiKey) missing.push('OPENAI_API_KEY');
  if (sttProvider === 'groq' && !sttApiKey) missing.push('GROQ_API_KEY');
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
  const turnDetectionRaw = optional(env, 'TURN_DETECTION', 'sarvam');
  if (turnDetectionRaw !== 'sarvam' && turnDetectionRaw !== 'hybrid') {
    throw new Error(`invalid TURN_DETECTION: ${turnDetectionRaw} (expected sarvam|hybrid)`);
  }
  const turnDetection: TurnDetection = turnDetectionRaw;
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
  const sttStreamType = optional(env, 'SARVAM_STT_STREAM_TYPE', 'fast');
  if (sttStreamType !== 'fast' && sttStreamType !== 'balanced' && sttStreamType !== 'simulated') {
    throw new Error(`invalid SARVAM_STT_STREAM_TYPE: ${sttStreamType} (expected fast|balanced|simulated)`);
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
    turnDetection,
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
    turnDeadlineMs: int(env, 'TURN_DEADLINE_MS', 6000),
    fixedAudioCacheDir: env.FIXED_AUDIO_CACHE_DIR,
    fixedPrewarmMs: int(env, 'FIXED_AUDIO_PREWARM_MS', 8000),
    openrouterSttFallback: bool(env, 'OPENROUTER_STT_FALLBACK', false),
    openrouterSttModel: optional(env, 'OPENROUTER_STT_MODEL', 'openai/gpt-4o-transcribe'),
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
      windowWorkingDays: appointmentsWindowWorkingDays,
    },
    sarvam: {
      apiKey: sarvamApiKey,
      baseUrl: optional(env, 'SARVAM_BASE_URL', 'https://api.sarvam.ai'),
      sttModel: optional(env, 'SARVAM_STT_MODEL', 'saaras:v3'),
      sttLanguageCode: optional(env, 'SARVAM_STT_LANGUAGE', 'en-IN'),
      sttMode: optional(env, 'SARVAM_STT_MODE', 'transcribe'),
      sttRealtime: bool(env, 'SARVAM_STT_REALTIME', true),
      sttRealtimeModel: optional(env, 'SARVAM_STT_REALTIME_MODEL', 'saaras:v3-realtime'),
      sttStreamType,
      sttPrompt: env.SARVAM_STT_PROMPT,
      sttFinalTimeoutMs: int(env, 'SARVAM_STT_FINAL_TIMEOUT_MS', 2000),
      // Provider defaults: the provider owns the residual fixed silence wait.
      sttVadThreshold: float(env, 'SARVAM_VAD_THRESHOLD', 0.3),
      sttVadSilenceMs: int(env, 'SARVAM_VAD_SILENCE_MS', 500),
      sttVadMinSpeechMs: int(env, 'SARVAM_VAD_MIN_SPEECH_MS', 250),
      ttsModel: optional(env, 'SARVAM_TTS_MODEL', 'bulbul:v3'),
      ttsSpeaker: optional(env, 'SARVAM_TTS_SPEAKER', 'shubh'),
      ttsLanguageCode: optional(env, 'SARVAM_TTS_LANGUAGE', 'en-IN'),
      ttsSampleRate: int(env, 'SARVAM_TTS_SAMPLE_RATE', 8000),
      ttsStream: bool(env, 'SARVAM_TTS_STREAM', true),
      ttsStreamIdleTimeoutMs: int(env, 'SARVAM_TTS_STREAM_IDLE_TIMEOUT_MS', 5000),
      ttsMinBufferSize: int(env, 'SARVAM_TTS_MIN_BUFFER_SIZE', 50),
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
    openrouterModel: optional(env, 'OPENROUTER_MODEL', 'deepseek/deepseek-v4-flash-0731'),
    openrouterTemperature: float(env, 'OPENROUTER_TEMPERATURE', 0.4),
    debugAudioDir: env.DEBUG_AUDIO_DIR,
  };
}
