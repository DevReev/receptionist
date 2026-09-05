/** One greppable JSON line per service event, to console. */
export function formatLogLine(event: Record<string, unknown>): string {
  return JSON.stringify({ ts: new Date().toISOString(), ...event });
}
