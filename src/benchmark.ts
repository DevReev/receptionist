import type { Transcription } from './app.ts';

/** One consented, deidentified 8 kHz mu-law utterance plus its expected fields. */
export interface BenchmarkFixture {
  name: string;
  audio: Buffer;
  reference: string;
  /** Expected critical fields stored separately from the reference transcript. */
  fields?: Record<string, string>;
}

export interface ReplayTarget {
  pushAudio(mulaw: Buffer): void;
  speechStart(): void;
  finalize(): Promise<Transcription>;
  close(): void;
}

export interface ReplayResult {
  transcript: string;
  /** Last replayed speech frame → provider final. */
  lastSpeechToFinalMs: number;
  frames: number;
}

export interface BenchmarkResult extends ReplayResult {
  fixture: string;
  reference: string;
  wer: number;
  fields: Record<string, boolean>;
}

export interface CandidateSummary {
  candidate: string;
  utterances: number;
  meanWer: number;
  fieldAccuracy: number;
  latency: { p50: number; p95: number; p99: number };
}

export interface ReplayOptions {
  frameBytes?: number;
  frameMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Nearest-rank percentile; empty input returns 0. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index]!;
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Word error rate via Levenshtein alignment. Empty reference scores 1 on drift. */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = tokens(reference);
  const hyp = tokens(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  let previous = Array.from({ length: hyp.length + 1 }, (_, i) => i);
  for (let i = 1; i <= ref.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= hyp.length; j += 1) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return previous[hyp.length]! / ref.length;
}

function normalizeField(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** Exact critical-field match against the decode; phones compare on digits. */
export function fieldMatches(expected: Record<string, string>, transcript: string): Record<string, boolean> {
  const normalized = normalizeField(transcript);
  const out: Record<string, boolean> = {};
  for (const [field, value] of Object.entries(expected)) {
    const digits = value.replace(/\D/g, '');
    if (digits.length >= 7 && /phone|number|mobile/i.test(field)) {
      out[field] = normalized.includes(digits.slice(-10));
    } else {
      out[field] = normalized.includes(normalizeField(value));
    }
  }
  return out;
}

/** Replay one utterance at real 20 ms Twilio frame timing through a live target. */
export async function replayUtterance(
  target: ReplayTarget,
  audio: Buffer,
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const frameBytes = options.frameBytes ?? 160;
  const frameMs = options.frameMs ?? 20;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  target.speechStart();
  let frames = 0;
  for (let offset = 0; offset < audio.length; offset += frameBytes) {
    target.pushAudio(Buffer.from(audio.subarray(offset, offset + frameBytes)));
    frames += 1;
    if (frameMs > 0 && offset + frameBytes < audio.length) await sleep(frameMs);
  }
  const spokeAt = now();
  const tx = await target.finalize();
  return { transcript: tx.text, lastSpeechToFinalMs: now() - spokeAt, frames };
}

export async function benchmarkFixture(
  target: ReplayTarget,
  fixture: BenchmarkFixture,
  options: ReplayOptions = {},
): Promise<BenchmarkResult> {
  const replay = await replayUtterance(target, fixture.audio, options);
  return {
    ...replay,
    fixture: fixture.name,
    reference: fixture.reference,
    wer: wordErrorRate(fixture.reference, replay.transcript),
    fields: fieldMatches(fixture.fields ?? {}, replay.transcript),
  };
}

export function summarize(candidate: string, results: BenchmarkResult[]): CandidateSummary {
  const latencies = results.map((result) => result.lastSpeechToFinalMs);
  const wer = results.length > 0 ? results.reduce((sum, r) => sum + r.wer, 0) / results.length : 0;
  const fieldValues = results.flatMap((result) => Object.values(result.fields));
  const fieldAccuracy =
    fieldValues.length > 0 ? fieldValues.filter(Boolean).length / fieldValues.length : 1;
  return {
    candidate,
    utterances: results.length,
    meanWer: wer,
    fieldAccuracy,
    latency: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
    },
  };
}
