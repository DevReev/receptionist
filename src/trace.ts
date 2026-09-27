/**
 * Structured tracing shared by every pipeline component. Each event is one
 * JSON line scoped with the call identity by `traceToConsole`, so a single
 * call can be replayed with `grep <callSid>` even under concurrent calls.
 */
export interface TraceEvent {
  component: string;
  event: string;
  [key: string]: unknown;
}

export type TraceFn = (event: TraceEvent) => void;

/**
 * Clip long payloads for logs while keeping both ends, so provider error
 * bodies and raw stream chunks stay diagnosable without flooding a line.
 */
export function clip(text: string, max = 500): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}…[${text.length - max} chars elided]…${text.slice(-half)}`;
}

/** Console sink: one `kind:"trace"` JSON line per event, with per-call scope. */
export function traceToConsole(scope: Record<string, unknown>): TraceFn {
  return (event) => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), kind: 'trace', ...scope, ...event }));
  };
}
