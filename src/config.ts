export const OPENAI_WHISPER_BASE_URL = 'https://api.openai.com/v1';
export const GROQ_WHISPER_BASE_URL = 'https://api.groq.com/openai/v1';

export interface Config {
  port: number;
  guidePath: string;
  sayVoice: string;
  sayLanguage: string;
  recordTimeout: number;
  recordMaxLength: number;
  twilioAccountSid: string;
  twilioAuthToken: string;
  sttApiKey: string;
  llmApiKey: string;
  whisperBaseUrl: string;
  whisperModel: string;
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

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing: string[] = [];
  const twilioAccountSid = required(env, 'TWILIO_ACCOUNT_SID', missing);
  const twilioAuthToken = required(env, 'TWILIO_AUTH_TOKEN', missing);
  // Either STT key works: OpenAI is the researched default, Groq serves the
  // same OpenAI-compatible transcription shape for whisper-large models.
  const sttApiKey = env.OPENAI_API_KEY ?? env.GROQ_API_KEY ?? '';
  if (!sttApiKey) missing.push('OPENAI_API_KEY or GROQ_API_KEY');
  const llmApiKey = env.OPENROUTER_API_KEY ?? env.OPEN_ROUTER ?? '';
  if (!llmApiKey) missing.push('OPENROUTER_API_KEY or OPEN_ROUTER');
  if (missing.length > 0) throw new Error(`missing required env: ${missing.join(', ')}`);
  const viaGroq = env.OPENAI_API_KEY === undefined && env.GROQ_API_KEY !== undefined;
  return {
    port: int(env, 'PORT', 3000),
    guidePath: optional(env, 'CLINIC_GUIDE_PATH', './clinic.md'),
    sayVoice: optional(env, 'SAY_VOICE', 'alice'),
    sayLanguage: optional(env, 'SAY_LANGUAGE', 'en-IN'),
    recordTimeout: int(env, 'RECORD_TIMEOUT', 5),
    recordMaxLength: int(env, 'RECORD_MAX_LENGTH', 30),
    twilioAccountSid,
    twilioAuthToken,
    sttApiKey,
    llmApiKey,
    whisperBaseUrl: optional(env, 'WHISPER_BASE_URL', viaGroq ? GROQ_WHISPER_BASE_URL : OPENAI_WHISPER_BASE_URL),
    whisperModel: optional(env, 'WHISPER_MODEL', viaGroq ? 'whisper-large-v3-turbo' : 'whisper-1'),
    openrouterModel: optional(env, 'OPENROUTER_MODEL', 'deepseek/deepseek-v4-flash-0731'),
  };
}
