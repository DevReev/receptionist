import type { SttConfig } from './whisper.ts';

const STT_PROVIDER_DEFAULTS = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo' },
} as const;

type SttProvider = keyof typeof STT_PROVIDER_DEFAULTS;

export type VoiceLoop = 'legacy' | 'stream';

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
  vadModelPath: string;
  twilioAccountSid: string;
  twilioAuthToken: string;
  stt: SttConfig;
  llmApiKey: string;
  openrouterModel: string;
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
  // Either STT key works: OpenAI is the researched default, Groq serves the
  // same OpenAI-compatible transcription shape for whisper-large models.
  const sttApiKey = env.OPENAI_API_KEY ?? env.GROQ_API_KEY ?? '';
  if (!sttApiKey) missing.push('OPENAI_API_KEY or GROQ_API_KEY');
  const llmApiKey = required(env, 'OPENROUTER_API_KEY', missing);
  const voiceLoopRaw = optional(env, 'VOICE_LOOP', 'legacy');
  if (voiceLoopRaw !== 'legacy' && voiceLoopRaw !== 'stream') {
    throw new Error(`invalid VOICE_LOOP: ${voiceLoopRaw} (expected legacy|stream)`);
  }
  const voiceLoop: VoiceLoop = voiceLoopRaw;
  const streamWsUrl =
    voiceLoop === 'stream' ? required(env, 'STREAM_WS_URL', missing) : optional(env, 'STREAM_WS_URL', '');
  if (missing.length > 0) throw new Error(`missing required env: ${missing.join(', ')}`);
  // Groq defaults apply only when the Groq key is the sole STT key; an
  // explicit OPENAI_API_KEY (or WHISPER_* overrides below) always wins.
  const useGroqDefaults: boolean = env.OPENAI_API_KEY === undefined && env.GROQ_API_KEY !== undefined;
  const provider: SttProvider = useGroqDefaults ? 'groq' : 'openai';
  const defaults = STT_PROVIDER_DEFAULTS[provider];
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
    vadThreshold: float(env, 'VAD_SPEECH_THRESHOLD', 0.5),
    vadModelPath: optional(env, 'VAD_MODEL_PATH', './models/silero_vad.onnx'),
    twilioAccountSid,
    twilioAuthToken,
    stt: {
      apiKey: sttApiKey,
      baseUrl: optional(env, 'WHISPER_BASE_URL', defaults.baseUrl),
      model: optional(env, 'WHISPER_MODEL', defaults.model),
    },
    llmApiKey,
    openrouterModel: optional(env, 'OPENROUTER_MODEL', 'deepseek/deepseek-v4-flash-0731'),
  };
}
