import { benchmarkFixture, loadFixtures, summarize, type BenchmarkResult } from '../src/benchmark.ts';
import { SarvamRealtimeStt } from '../src/sarvamRealtime.ts';

interface Candidate {
  name: string;
  model: string;
  streamType: string;
}

function candidates(): Candidate[] {
  const raw = process.env.BENCH_STT_MODELS ?? 'saaras:v3-realtime:fast,saaras:v3-realtime:balanced';
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [model, streamType = 'fast'] = entry.split(':');
      return { name: entry, model: model!, streamType };
    });
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width);
}

function printResults(summaries: ReturnType<typeof summarize>[], all: Map<string, BenchmarkResult[]>): void {
  console.log(
    `${pad('candidate', 34)}${pad('utt', 5)}${pad('WER', 8)}${pad('fields', 9)}${pad('p50', 7)}${pad('p95', 7)}${pad('p99', 7)}`,
  );
  for (const summary of summaries) {
    console.log(
      `${pad(summary.candidate, 34)}${pad(summary.utterances, 5)}${pad(summary.meanWer.toFixed(3), 8)}${pad(
        summary.fieldAccuracy.toFixed(3),
        9,
      )}${pad(`${summary.latency.p50}`, 7)}${pad(`${summary.latency.p95}`, 7)}${pad(`${summary.latency.p99}`, 7)}`,
    );
    for (const result of all.get(summary.candidate) ?? []) {
      const misses = Object.entries(result.fields)
        .filter(([, ok]) => !ok)
        .map(([field]) => field);
      console.log(
        `  ${pad(result.fixture, 28)}${pad(`${result.wer.toFixed(2)}`, 7)}${pad(`${result.lastSpeechToFinalMs}ms`, 9)}${
          misses.length > 0 ? ` miss: ${misses.join(', ')}` : ''
        }`,
      );
      if (process.env.BENCH_SHOW_TRANSCRIPTS === 'true') {
        console.log(`    ref: ${result.reference}`);
        console.log(`    got: ${result.transcript}`);
      }
    }
  }
}

export async function main(): Promise<void> {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error('SARVAM_API_KEY is required for live benchmark replay');
  const dir = process.env.BENCH_FIXTURES ?? './bench-fixtures';
  const fixtures = await loadFixtures(dir);
  if (fixtures.length === 0) throw new Error(`no .mulaw fixtures in ${dir}`);
  const baseUrl = process.env.SARVAM_BASE_URL ?? 'https://api.sarvam.ai';
  const languageCode = process.env.SARVAM_STT_LANGUAGE ?? 'en-IN';
  const prompt = process.env.SARVAM_STT_PROMPT;
  const summaries = [];
  const all = new Map<string, BenchmarkResult[]>();
  for (const candidate of candidates()) {
    const results: BenchmarkResult[] = [];
    for (const fixture of fixtures) {
      const target = new SarvamRealtimeStt({
        config: {
          apiKey,
          baseUrl,
          model: candidate.model,
          languageCode,
          streamType: candidate.streamType,
          mode: 'transcribe',
          encoding: 'mulaw',
          sampleRate: 8000,
          finalTimeoutMs: 4000,
          ...(prompt ? { prompt } : {}),
        },
      });
      try {
        results.push(await benchmarkFixture(target, fixture, { frameMs: 20 }));
      } finally {
        target.close();
      }
    }
    all.set(candidate.name, results);
    summaries.push(summarize(candidate.name, results));
  }
  printResults(summaries, all);
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('benchmark.ts')) {
  void main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
