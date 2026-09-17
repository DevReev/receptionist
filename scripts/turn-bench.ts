import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { loadFixtures } from '../src/benchmark.ts';
import {
  aggregateMetrics,
  defaultTurnBenchScenarios,
  formatTurnBenchReport,
  runScenario,
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

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === 'true' || raw === '1';
}

function buildId(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Turn-taking bench: scripted calls through the real live session with stubbed
 * STT/TTS, no network. Echo is synthesized from the session's own outbound
 * reference at varied delay and attenuation.
 *
 *   npm run turn-bench
 *   TURN_BENCH_JSON=bench-scripts/turn-bench.json npm run turn-bench
 *
 * Policy knobs mirror the shipped configuration (`ENDPOINT_SILENCE_MS` etc.)
 * so the reported baseline is the build under real defaults.
 */
export async function main(): Promise<void> {
  const fixtureDir = process.env.BENCH_FIXTURES ?? './bench-fixtures';
  const fixtures = await loadFixtures(fixtureDir).catch(() => []);
  const scenarios = defaultTurnBenchScenarios().map((scenario, index) => ({
    ...scenario,
    ...(fixtures.length > 0 && scenario.callerAudio === undefined
      ? { callerAudio: fixtures[index % fixtures.length]!.audio }
      : {}),
  }));
  const options: TurnBenchOptions = {
    policy: {
      silenceMs: intEnv('ENDPOINT_SILENCE_MS', 1000),
      minSpeechMs: intEnv('ENDPOINT_MIN_SPEECH_MS', 300),
      maxUtteranceMs: intEnv('ENDPOINT_MAX_UTTERANCE_MS', 30000),
      threshold: floatEnv('VAD_SPEECH_THRESHOLD', 0.1),
      latchDipMs: intEnv('ENDPOINT_LATCH_DIP_MS', 200),
    },
    bargeIn: boolEnv('BARGE_IN', false),
    interruptionMs: intEnv('BARGE_IN_SPEECH_MS', 200),
    ...(process.env.TURN_BENCH_DEBUG === 'true' ? { debug: true } : {}),
  };
  const runs = [];
  for (const scenario of scenarios) {
    runs.push(await runScenario(scenario, options));
  }
  const metrics = runs.map((run) => run.metrics);
  const aggregate = aggregateMetrics(metrics);
  const meta = { build: buildId(), policy: options.policy, fixtures: fixtures.length };
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
