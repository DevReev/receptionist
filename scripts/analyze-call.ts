import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeWavPcm } from '../src/audio.ts';
import { rms } from '../src/echoGate.ts';
import { analyzeCall, callSids, formatLiveCallReport, parseLogLines, type LiveCallMetrics } from '../src/liveAnalysis.ts';

/**
 * Analyze one live call's JSON log for the ticket-10 acceptance report:
 *
 *   node scripts/analyze-call.ts                          # latest call in /tmp/receptionist.log
 *   node scripts/analyze-call.ts --call CAxxxx            # a specific call
 *   node scripts/analyze-call.ts --list                   # calls present in the log
 *   node scripts/analyze-call.ts --json bench-scripts/10-live-call.json --audio-dir debug-audio
 *
 * The log is the stdout capture the RUNBOOK tails into /tmp/receptionist.log.
 * The audio directory (when present) is decoded to duration and level, so the
 * retained Caller audio is analyzed, not just listed.
 */
export interface AnalyzeCallOptions {
  logPath: string;
  callSid?: string;
  audioDir?: string;
  jsonPath?: string;
  list?: boolean;
}

interface AudioFile {
  path: string;
  bytes: number;
  durationMs: number;
  rms: number;
  audible: boolean;
}

/** Captured utterance below this RMS is silence, same floor as the bench. */
const AUDIBLE_RMS = 60;

function parseArgs(argv: string[]): AnalyzeCallOptions {
  const options: AnalyzeCallOptions = { logPath: '/tmp/receptionist.log' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--call') {
      options.callSid = argv[++i];
    } else if (arg === '--json') {
      const next = argv[++i];
      if (next !== undefined) options.jsonPath = next;
    } else if (arg === '--audio-dir') {
      options.audioDir = argv[++i];
    } else if (arg === '--list') {
      options.list = true;
    } else if (arg !== undefined && !arg.startsWith('--')) {
      options.logPath = arg;
    }
  }
  return options;
}

async function audioInventory(dir: string | undefined, callSid: string): Promise<AudioFile[]> {
  if (dir === undefined) return [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files: AudioFile[] = [];
  for (const name of names.filter((entry) => entry.startsWith(`${callSid}-turn`) && entry.endsWith('.wav')).sort()) {
    const path = join(dir, name);
    try {
      const wav = await readFile(path);
      const { pcm } = decodeWavPcm(wav);
      const level = rms(pcm);
      files.push({
        path,
        bytes: wav.length,
        durationMs: Math.round((pcm.length / 8000) * 1000),
        rms: Math.round(level),
        audible: level >= AUDIBLE_RMS,
      });
    } catch {
      // Not readable; the log's audio-dump line remains the evidence.
    }
  }
  return files;
}

export async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  let text: string;
  try {
    text = await readFile(options.logPath, 'utf8');
  } catch {
    console.error(`cannot read log: ${options.logPath}`);
    process.exitCode = 1;
    return;
  }
  const lines = parseLogLines(text);
  const sids = callSids(lines);
  if (sids.length === 0) {
    console.error(`no calls found in ${options.logPath}`);
    process.exitCode = 1;
    return;
  }
  if (options.list) {
    for (const sid of sids) console.log(sid);
    return;
  }
  const callSid = options.callSid ?? sids[sids.length - 1]!;
  if (!sids.includes(callSid)) {
    console.error(`call ${callSid} not in ${options.logPath} (available: ${sids.join(', ')})`);
    process.exitCode = 1;
    return;
  }
  const metrics: LiveCallMetrics = analyzeCall(lines, callSid);
  const audio = await audioInventory(options.audioDir, callSid);
  console.log(formatLiveCallReport(metrics));
  if (audio.length > 0) {
    const totalMs = audio.reduce((sum, file) => sum + file.durationMs, 0);
    const audible = audio.filter((file) => file.audible).length;
    console.log(`audio files ${audio.length} audible ${audible} (${totalMs}ms): ${audio.map((file) => file.path).join(' ')}`);
  } else {
    console.log('audio files 0 (debug-audio captures absent or not requested)');
  }
  const jsonPath = options.jsonPath;
  if (jsonPath !== undefined) {
    await writeFile(jsonPath, JSON.stringify({ metrics, audio }, null, 2));
    console.log(`\nwrote ${jsonPath}`);
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('analyze-call.ts')) {
  void main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
