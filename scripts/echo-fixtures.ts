import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { wavToMulaw } from '../src/audio.ts';
import { mixEcho } from '../src/echoMix.ts';

async function loadReference(path: string): Promise<Buffer> {
  const raw = await readFile(path);
  // A receptionist reference is 8 kHz mulaw or a WAV in any rate (resampled).
  return path.endsWith('.wav') ? wavToMulaw(raw) : raw;
}

/**
 * Contaminate every captured Caller fixture with the outbound reference at
 * varied delay and attenuation. Writes `<name>-echo-d<ms>-a<db>.mulaw` plus a
 * sidecar recording the source, reference, and the span where Echo returns.
 *
 *   BENCH_FIXTURES=./bench-fixtures ECHO_REFERENCE=./ref.mulaw npm run echo-fixtures
 */
export async function main(): Promise<void> {
  const fixtureDir = process.env.BENCH_FIXTURES ?? './bench-fixtures';
  const referencePath = process.env.ECHO_REFERENCE;
  if (!referencePath) {
    throw new Error('ECHO_REFERENCE is required: an 8 kHz mulaw or WAV receptionist reference signal');
  }
  const outDir = process.env.ECHO_FIXTURE_DIR ?? join(fixtureDir, 'echo');
  const delays = (process.env.ECHO_DELAYS_MS ?? '60,120,240').split(',').map((value) => Number.parseInt(value, 10));
  const attenuations = (process.env.ECHO_ATTENUATIONS_DB ?? '-12,-18,-24').split(',').map((value) => Number.parseFloat(value));
  const reference = await loadReference(referencePath);
  const files = (await readdir(fixtureDir)).filter((name) => name.endsWith('.mulaw')).sort();
  if (files.length === 0) throw new Error(`no .mulaw fixtures in ${fixtureDir}`);
  await mkdir(outDir, { recursive: true });
  let written = 0;
  for (const file of files) {
    const caller = await readFile(join(fixtureDir, file));
    const name = file.replace(/\.mulaw$/, '');
    for (const delayMs of delays) {
      for (const attenuationDb of attenuations) {
        const label = `${name}-echo-d${delayMs}-a${attenuationDb}`;
        const mixed = mixEcho(caller, reference, { delayMs, attenuationDb });
        await writeFile(join(outDir, `${label}.mulaw`), mixed);
        await writeFile(
          join(outDir, `${label}.json`),
          JSON.stringify(
            {
              source: name,
              sourceFile: file,
              reference: referencePath,
              delayMs,
              attenuationDb,
              sampleRate: 8000,
              encoding: 'mulaw',
              callerFrames: Math.ceil(caller.length / 160),
              echoStartFrame: Math.round(delayMs / 20),
              echoFrames: Math.ceil(reference.length / 160),
            },
            null,
            2,
          ),
        );
        written += 1;
      }
    }
  }
  console.log(`fixtures: ${files.length}  variants per fixture: ${delays.length * attenuations.length}`);
  console.log(`reference: ${referencePath} (${reference.length} bytes)`);
  console.log(`wrote ${written} echo-mixed fixtures to ${outDir}`);
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('echo-fixtures.ts')) {
  void main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
