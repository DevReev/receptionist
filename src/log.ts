import type { FailureEvent } from './app.ts';

/** One greppable JSON line per failure; the clinic owner's only handoff channel. */
export function formatFailureLine(event: FailureEvent): string {
  return JSON.stringify({ ts: new Date().toISOString(), ...event });
}
