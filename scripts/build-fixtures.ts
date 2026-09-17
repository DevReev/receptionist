import { buildFixturesFromCapture } from '../src/capture.ts';

/**
 * Convert DEBUG_AUDIO_DIR captures into bench-fixtures pairs.
 *
 *   CAPTURE_DIR=./debug-audio FIXTURE_DIR=./bench-fixtures npm run fixtures
 *
 * References start as the STT decode; correct them against bench-scripts/ and
 * fill `fields` before treating benchmark numbers as ground truth.
 */
async function main(): Promise<void> {
  const captureDir = process.env.CAPTURE_DIR ?? './debug-audio';
  const outDir = process.env.FIXTURE_DIR ?? './bench-fixtures';
  const overwrite = process.env.FORCE === 'true';
  const result = await buildFixturesFromCapture({ captureDir, outDir, overwrite });
  console.log(`capture dir: ${captureDir}`);
  console.log(`fixture dir: ${outDir}`);
  console.log(`written: ${result.written}  skipped: ${result.skipped}`);
  for (const warning of result.warnings) console.log(`warn: ${warning}`);
  if (result.written > 0) {
    console.log('');
    console.log('Next: open each bench-fixtures/*.json and set `reference` + `fields` from the matching call script.');
    console.log('Then: BENCH_STT_MODELS=... npm run benchmark');
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('build-fixtures.ts')) {
  void main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
