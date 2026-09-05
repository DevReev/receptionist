export interface Config {
  port: number;
  pageId: string;
  staffId: string | undefined;
  bearerKey: string;
  timeZone: string;
  poolSize: number;
  navigationTimeoutMs: number;
  actionTimeoutMs: number;
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
  const pageId = required(env, 'PICKTIME_PAGE_ID', missing);
  const bearerKey = required(env, 'API_BEARER_KEY', missing);
  if (missing.length > 0) throw new Error(`missing required env: ${missing.join(', ')}`);
  const staffId = env.PICKTIME_STAFF_ID || undefined;
  return {
    port: int(env, 'PORT', 3000),
    pageId,
    staffId,
    bearerKey,
    timeZone: optional(env, 'TZ', 'Asia/Kolkata'),
    poolSize: int(env, 'BROWSER_POOL_SIZE', 4),
    navigationTimeoutMs: int(env, 'NAVIGATION_TIMEOUT_MS', 10_000),
    actionTimeoutMs: int(env, 'ACTION_TIMEOUT_MS', 5_000),
  };
}
