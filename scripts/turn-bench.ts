import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { loadFixtures } from '../src/benchmark.ts';
import { BARGE_IN_DEFAULTS, LOCAL_ENDPOINT_FALLBACKS } from '../src/endpoint.ts';
import {
  aggregateMetrics,
  defaultTurnBenchScenarios,
  formatTurnBenchReport,
  runScenario,
  type EchoVariant,
  type TurnBenchOptions,
} from '../src/turnBench.ts';

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function floatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function buildId(): string {
  let head: string;
  try {
    head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
  try {
    execFileSync('git', ['diff-index', '--quiet', 'HEAD', '--'], { stdio: 'ignore' });
    return head;
  } catch {
    return `${head}-dirty`;
  }
}

function echoVariants(): EchoVariant[] {
  const raw = process.env.TURN_BENCH_ECHOES ?? '60:-12,120:-18,240:-24';
  const variants = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [delay, attenuation] = entry.split(':');
      return { delayMs: Number.parseInt(delay ?? '', 10), attenuationDb: Number.parseFloat(attenuation ?? '') };
    })
    .filter((variant) => Number.isFinite(variant.delayMs) && Number.isFinite(variant.attenuationDb));
  return variants.length > 0 ? variants : [{ delayMs: 120, attenuationDb: -18 }];
}

/**
 * Turn-taking bench: scripted calls through the real live session with stubbed
 * STT/TTS, no network. Echo is synthesized from the session's own outbound
 * reference at varied delay and attenuation.
 *
 *   npm run turn-bench
 *   TURN_BENCH_JSON=bench-scripts/turn-bench.json npm run turn-bench
 *
 * The local detector's fixed silence and max-utterance knobs left the
 * production env surface with the provider VAD change; the bench runs the
 * shipped local policy with `TURN_BENCH_*` overrides for sweeps.
 */
export async function main(): Promise<void> {
  const fixtureDir = process.env.BENCH_FIXTURES ?? './bench-fixtures';
  const fixtures = await loadFixtures(fixtureDir).catch(() => []);
  const scenarios = defaultTurnBenchScenarios(echoVariants()).map((scenario, index) => ({
    ...scenario,
    ...(fixtures.length > 0 && scenario.callerAudio === undefined
      ? { callerAudio: fixtures[index % fixtures.length]!.audio }
      : {}),
  }));
  const options: TurnBenchOptions = {
    policy: {
      silenceMs: intEnv('TURN_BENCH_SILENCE_MS', LOCAL_ENDPOINT_FALLBACKS.silenceMs),
      maxUtteranceMs: intEnv('TURN_BENCH_MAX_UTTERANCE_MS', LOCAL_ENDPOINT_FALLBACKS.maxUtteranceMs),
      minSpeechMs: intEnv('TURN_BENCH_MIN_SPEECH_MS', LOCAL_ENDPOINT_FALLBACKS.minSpeechMs),
      threshold: floatEnv('VAD_SPEECH_THRESHOLD', 0.1),
      latchDipMs: intEnv('TURN_BENCH_LATCH_DIP_MS', LOCAL_ENDPOINT_FALLBACKS.latchDipMs),
    },
    bargeInMinSpeechMs: intEnv('BARGE_IN_MIN_SPEECH_MS', BARGE_IN_DEFAULTS.minSpeechMs),
    bargeInDipToleranceMs: intEnv('BARGE_IN_DIP_TOLERANCE_MS', BARGE_IN_DEFAULTS.dipToleranceMs),
    bargeInConfirmMs: intEnv('BARGE_IN_CONFIRM_MS', BARGE_IN_DEFAULTS.confirmMs),
    ...(process.env.TURN_BENCH_DEBUG === 'true' ? { debug: true } : {}),
  };
  const runs = [];
  for (const scenario of scenarios) {
    runs.push(await runScenario(scenario, options));
  }
  const metrics = runs.map((run) => run.metrics);
  const aggregate = aggregateMetrics(metrics);
  const meta = {
    build: buildId(),
    policy: options.policy,
    fixtures: fixtures.length,
    bargeInMinSpeechMs: options.bargeInMinSpeechMs!,
    bargeInDipToleranceMs: options.bargeInDipToleranceMs!,
    bargeInConfirmMs: options.bargeInConfirmMs!,
  };
  console.log(formatTurnBenchReport(meta, metrics, aggregate));
  const jsonPath = process.env.TURN_BENCH_JSON;
  if (jsonPath) {
    await writeFile(jsonPath, JSON.stringify({ meta, scenarios: metrics, aggregate }, null, 2));
    console.log(`\nwrote ${jsonPath}`);
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('turn-bench.ts')) {
  void main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
