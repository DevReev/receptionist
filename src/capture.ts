import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeWavPcm, encodeMulaw } from './audio.ts';

/** Sidecar written next to each captured utterance WAV by the live server. */
export interface CaptureSidecar {
  callSid: string;
  turn: number;
  text: string;
  /** STT decode bytes for a quick sanity check; not used for the fixture. */
  bytes?: number;
  capturedAt?: string;
}

export interface FixtureMeta {
  reference: string;
  fields: Record<string, string>;
  source: { callSid: string; turn: number };
  capturedAt?: string;
}

export interface BuiltFixture {
  name: string;
  mulaw: Buffer;
  meta: FixtureMeta;
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Convert one captured 8 kHz WAV utterance into the benchmark fixture pair:
 * headerless mu-law bytes plus metadata. `reference` starts as the STT decode
 * so it must be corrected against the call script before field scoring.
 */
export function fixtureFromCapture(sidecar: CaptureSidecar, wav: Buffer): BuiltFixture {
  const { pcm, sampleRate } = decodeWavPcm(wav);
  if (sampleRate !== 8000) throw new Error(`capture-not-8khz:${sampleRate}`);
  return {
    name: safeName(`${sidecar.callSid}-turn${sidecar.turn}`),
    mulaw: encodeMulaw(pcm),
    meta: {
      reference: sidecar.text,
      fields: {},
      source: { callSid: sidecar.callSid, turn: sidecar.turn },
      ...(sidecar.capturedAt ? { capturedAt: sidecar.capturedAt } : {}),
    },
  };
}

export interface BuildResult {
  written: number;
  skipped: number;
  names: string[];
  warnings: string[];
}

/**
 * Read `*.json` sidecars from the capture dir and write `<name>.mulaw` +
 * `<name>.json` benchmark fixtures. Existing fixtures are kept unless
 * `overwrite` is set.
 */
export async function buildFixturesFromCapture(opts: {
  captureDir: string;
  outDir: string;
  overwrite?: boolean;
}): Promise<BuildResult> {
  const result: BuildResult = { written: 0, skipped: 0, names: [], warnings: [] };
  let files: string[];
  try {
    files = await readdir(opts.captureDir);
  } catch {
    return result;
  }
  await mkdir(opts.outDir, { recursive: true });
  for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
    const base = file.replace(/\.json$/, '');
    let sidecar: CaptureSidecar;
    try {
      sidecar = JSON.parse(await readFile(join(opts.captureDir, file), 'utf8')) as CaptureSidecar;
    } catch {
      result.warnings.push(`${file}: unreadable sidecar`);
      result.skipped += 1;
      continue;
    }
    if (typeof sidecar.callSid !== 'string' || typeof sidecar.turn !== 'number' || typeof sidecar.text !== 'string') {
      result.warnings.push(`${file}: malformed sidecar`);
      result.skipped += 1;
      continue;
    }
    let wav: Buffer;
    try {
      wav = await readFile(join(opts.captureDir, `${base}.wav`));
    } catch {
      result.warnings.push(`${base}: WAV missing`);
      result.skipped += 1;
      continue;
    }
    let fixture: BuiltFixture;
    try {
      fixture = fixtureFromCapture(sidecar, wav);
    } catch (err) {
      result.warnings.push(`${base}: ${err instanceof Error ? err.message : String(err)}`);
      result.skipped += 1;
      continue;
    }
    const mulawPath = join(opts.outDir, `${fixture.name}.mulaw`);
    const metaPath = join(opts.outDir, `${fixture.name}.json`);
    if (!opts.overwrite) {
      try {
        await readFile(mulawPath);
        result.skipped += 1;
        continue;
      } catch {
        // Not built yet.
      }
    }
    await writeFile(mulawPath, fixture.mulaw);
    await writeFile(metaPath, JSON.stringify(fixture.meta, null, 2));
    result.written += 1;
    result.names.push(fixture.name);
  }
  return result;
}
