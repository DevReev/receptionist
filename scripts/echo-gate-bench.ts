import { readFile, writeFile } from 'node:fs/promises';
import { wavToMulaw } from '../src/audio.ts';
import { loadFixtures } from '../src/benchmark.ts';
import { aggregateEchoBench, classifyEchoMix, correlatedDoubleTalkCase, playbackTailCase, type EchoBenchCaseResult } from '../src/echoGateBench.ts';
import { syntheticVoice } from '../src/turnBench.ts';

function numberList(name: string, fallback: string): number[] {
  const raw = process.env[name] ?? fallback;
  const values = raw
    .split(',')
    .map((value) => Number.parseFloat(value.trim()))
    .filter((value) => Number.isFinite(value));
  return values.length > 0 ? values : fallback.split(',').map((value) => Number.parseFloat(value));
}

async function loadReference(path: string): Promise<Buffer> {
  const raw = await readFile(path);
  return path.endsWith('.wav') ? wavToMulaw(raw) : raw;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Echo-gate classification bench: run every captured Caller fixture through
 * the mix generator at each delay/attenuation variant, then score the gate's
 * per-frame decisions against the known mix. Writes the false-pass and
 * false-block rates the ticket records, and whether they meet the bars.
 *
 *   ECHO_REFERENCE=./ref.mulaw npm run echo-gate-bench
 *   ECHO_GATE_BENCH_JSON=bench-scripts/echo-gate.json npm run echo-gate-bench
 *
 * Without fixtures or a reference the bench synthesizes both, so it always
 * produces numbers; only the local fixture run reflects captured audio.
 */
export async function main(): Promise<void> {
  const fixtureDir = process.env.BENCH_FIXTURES ?? './bench-fixtures';
  const fixtures = await loadFixtures(fixtureDir).catch(() => []);
  const callers = fixtures.length > 0 ? fixtures : [{ name: 'synthetic', audio: syntheticVoice(8000 * 3, 3), reference: '' }];
  const referencePath = process.env.ECHO_REFERENCE;
  const reference = referencePath ? await loadReference(referencePath) : syntheticVoice(8000 * 4, 7);
  const delays = numberList('ECHO_DELAYS_MS', '60,120,240');
  const attenuations = numberList('ECHO_ATTENUATIONS_DB', '-12,-18,-24');
  const cases: EchoBenchCaseResult[] = [];
  for (const fixture of callers) {
    for (const delayMs of delays) {
      for (const attenuationDb of attenuations) {
        cases.push({
          name: `${fixture.name}-d${delayMs}-a${attenuationDb}`,
          delayMs,
          attenuationDb,
          counts: classifyEchoMix({ name: fixture.name, caller: fixture.audio, reference, mix: { delayMs, attenuationDb } }),
        });
      }
    }
  }
  // Synthetic window cases, independent of captured fixtures: the playback
  // tail (Echo outliving the reference, then late Caller speech) and a Caller
  // that correlates strongly with the reference while carrying excess energy.
  for (const extra of [playbackTailCase(), correlatedDoubleTalkCase()]) {
    cases.push({
      name: `${extra.name}-d${extra.mix.delayMs}-a${extra.mix.attenuationDb}`,
      delayMs: extra.mix.delayMs,
      attenuationDb: extra.mix.attenuationDb,
      counts: classifyEchoMix(extra),
    });
  }
  const summary = aggregateEchoBench(cases);
  console.log(
    `echo-gate bench  callers ${callers.length}${fixtures.length === 0 ? ' (synthetic fallback)' : ''}  reference ${
      referencePath ?? 'synthetic'
    }  variants ${delays.length}x${attenuations.length}`,
  );
  console.log(
    `frames: pure-echo ${summary.pureEchoFrames}  caller ${summary.callerFrames} (double-talk ${summary.doubleTalkFrames})  silence ${summary.silenceFrames}  decisions ${summary.decisions}`,
  );
  console.log(
    `false-pass ${percent(summary.falsePassRate)} (${summary.echoFalsePasses}/${summary.pureEchoFrames})  false-block ${percent(
      summary.falseBlockRate,
    )} (${summary.callerFalseBlocks}/${summary.callerFrames})  ->  ${summary.pass ? 'PASS' : 'FAIL'}`,
  );
  const jsonPath = process.env.ECHO_GATE_BENCH_JSON;
  if (jsonPath) {
    await writeFile(jsonPath, JSON.stringify({ delays, attenuations, summary, cases }, null, 2));
    console.log(`\nwrote ${jsonPath}`);
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('echo-gate-bench.ts')) {
  void main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
