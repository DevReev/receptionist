export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface SayOptions {
  voice: string;
  language: string;
}
export function say(text: string, opts: SayOptions): string {
  return `<Say voice="${esc(opts.voice)}" language="${esc(opts.language)}">${esc(text)}</Say>`;
}

export function recordTurn(opts: {
  voice: string;
  language: string;
  action: string;
  statusCallback: string;
  timeout: number;
  maxLength: number;
}): string {
  return (
    `<Record action="${esc(opts.action)}" method="POST" ` +
    `timeout="${opts.timeout}" maxLength="${opts.maxLength}" finishOnKey="#" playBeep="false" ` +
    `recordingStatusCallback="${esc(opts.statusCallback)}" />`
  );
}

export function connectStream(url: string, params: Record<string, string> = {}): string {
  const entries = Object.entries(params);
  if (entries.length === 0) return `<Connect><Stream url="${esc(url)}"/></Connect>`;
  const children = entries
    .map(([name, value]) => `<Parameter name="${esc(name)}" value="${esc(value)}"/>`)
    .join('');
  return `<Connect><Stream url="${esc(url)}">${children}</Stream></Connect>`;
}

export function hangup(): string {
  return '<Hangup/>';
}

export function twiml(...verbs: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${verbs.join('')}</Response>`;
}
