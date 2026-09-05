import { readFile } from 'node:fs/promises';

export interface ClinicGuide {
  raw: string;
  name: string;
}

/** Name shown to callers. Placeholders ({…}) mean "not filled in yet". */
export const FALLBACK_CLINIC_NAME = 'the clinic';

export function extractClinicName(raw: string): string {
  const match = /^#\s+Clinic Guide\s+[—–-]\s*(.+?)\s*$/m.exec(raw);
  if (!match) return FALLBACK_CLINIC_NAME;
  const name = match[1].trim();
  if (!name || name.includes('{') || name.includes('}')) return FALLBACK_CLINIC_NAME;
  return name;
}

/** Re-read every call: the file is tiny, so edits take effect on the next turn with no watcher. */
export async function loadClinicGuide(path: string): Promise<ClinicGuide> {
  const raw = await readFile(path, 'utf8');
  return { raw, name: extractClinicName(raw) };
}
