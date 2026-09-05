export interface Config {
  port: number;
  guidePath: string;
  sayVoice: string;
  sayLanguage: string;
  recordTimeout: number;
  recordMaxLength: number;
  twilioAccountSid: string;
  twilioAuthToken: string;
  openaiApiKey: string;
  openrouterApiKey: string;
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
  const openaiApiKey = required(env, 'OPENAI_API_KEY', missing);
  const openrouterApiKey = required(env, 'OPENROUTER_API_KEY', missing);
  if (missing.length > 0) throw new Error(`missing required env: ${missing.join(', ')}`);
  return {
    port: int(env, 'PORT', 3000),
    guidePath: optional(env, 'CLINIC_GUIDE_PATH', './clinic.md'),
    sayVoice: optional(env, 'SAY_VOICE', 'alice'),
    sayLanguage: optional(env, 'SAY_LANGUAGE', 'en-IN'),
    recordTimeout: int(env, 'RECORD_TIMEOUT', 5),
    recordMaxLength: int(env, 'RECORD_MAX_LENGTH', 30),
    twilioAccountSid,
    twilioAuthToken,
    openaiApiKey,
    openrouterApiKey,
    openrouterModel: optional(env, 'OPENROUTER_MODEL', 'deepseek/deepseek-v4-flash-0731'),
  };
}
