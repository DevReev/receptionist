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

function sectionLines(raw: string, title: string): string[] {
  const lines = raw.split('\n');
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      inSection = heading[1]!.trim().toLowerCase() === title.toLowerCase();
      continue;
    }
    if (inSection) out.push(line);
  }
  return out;
}

/**
 * Stable terminology hint for streaming STT: clinic, location, doctor, and
 * service names from the guide. Never includes Patient names.
 */
export function deriveSttPrompt(guide: ClinicGuide): string {
  const terms: string[] = [];
  const add = (value: string): void => {
    const term = value.trim();
    if (term.length > 0 && !term.includes('{') && !terms.includes(term)) terms.push(term);
  };
  if (guide.name !== FALLBACK_CLINIC_NAME) add(guide.name);
  for (const title of ['Locations', 'Doctor', 'Services and fees']) {
    for (const line of sectionLines(guide.raw, title)) {
      const match = /-\s+\*\*(.+?)\*\*/.exec(line);
      if (match) add(match[1]!);
    }
  }
  return terms.join(', ');
}
