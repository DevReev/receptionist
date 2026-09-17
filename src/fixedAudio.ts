import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TraceEvent, TraceFn } from './trace.ts';

const FORMAT_VERSION = 1;
const KEY_PREFIX = 'v1';
const KEY_HEX_LENGTH = 32;

export interface FixedAudioCacheOptions {
  /** Identity of the audio producer; part of every key. */
  provider: string;
  model: string;
  voice: string;
  language: string;
  sampleRate: number;
  encoding: string;
  /** Optional directory for persistence across restarts. */
  dir?: string;
  onTrace?: TraceFn;
}

interface DiskEntry {
  v: number;
  text: string;
  audio: string;
  provider: string;
  model: string;
  voice: string;
  language: string;
  sampleRate: number;
  encoding: string;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function decodeBase64(value: unknown): Buffer | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length === 0) return Buffer.alloc(0);
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : undefined;
}

export class FixedAudioCache {
  private readonly provider: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly language: string;
  private readonly sampleRate: number;
  private readonly encoding: string;
  private readonly dir?: string;
  private readonly onTrace?: TraceFn;
  private readonly entries = new Map<string, Buffer>();
  private readonly diskKeys = new Set<string>();
  private hits = 0;
  private misses = 0;

  constructor(opts: FixedAudioCacheOptions) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.voice = opts.voice;
    this.language = opts.language;
    this.sampleRate = opts.sampleRate;
    this.encoding = opts.encoding;
    this.dir = opts.dir;
    this.onTrace = opts.onTrace;
  }

  /** Versioned hash key over provider/model/voice/language/sampleRate/encoding/exact text. */
  key(text: string): string {
    const digest = createHash('sha256')
      .update(
        JSON.stringify([
          FORMAT_VERSION,
          this.provider,
          this.model,
          this.voice,
          this.language,
          this.sampleRate,
          this.encoding,
          text,
        ]),
      )
      .digest('hex');
    return `${KEY_PREFIX}-${digest.slice(0, KEY_HEX_LENGTH)}`;
  }

  /** Returns a copy of the cached 8 kHz mu-law bytes, or undefined. */
  get(text: string): Buffer | undefined {
    const stored = this.entries.get(this.key(text));
    if (!stored) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return Buffer.from(stored);
  }

  /** Stores a defensive copy. */
  set(text: string, audio: Buffer): void {
    const key = this.key(text);
    this.entries.set(key, Buffer.from(audio));
    void this.saveToDisk(text).catch((err: unknown) => {
      this.trace({ component: 'fixed-audio', event: 'save-error', key, detail: describe(err) });
    });
  }

  /** Load `<key>.json` entries from the configured dir. Returns the count loaded. Corrupt/mismatched files are ignored. */
  async loadFromDisk(): Promise<number> {
    const dir = this.dir;
    if (!dir) return 0;
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return 0;
    }
    let count = 0;
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      let raw: string;
      try {
        raw = await readFile(join(dir, file), 'utf8');
      } catch {
        continue;
      }
      const parsed = this.readEntry(file, raw);
      if (!parsed) continue;
      this.entries.set(parsed.key, parsed.audio);
      this.diskKeys.add(parsed.key);
      count += 1;
    }
    this.trace({ component: 'fixed-audio', event: 'load', count });
    return count;
  }

  /** Persist one entry atomically (tmp file + rename). No-op when dir is unset. */
  async saveToDisk(text: string): Promise<void> {
    const dir = this.dir;
    if (!dir) return;
    const key = this.key(text);
    const stored = this.entries.get(key);
    if (!stored) return;
    const entry: DiskEntry = {
      v: FORMAT_VERSION,
      text,
      audio: stored.toString('base64'),
      provider: this.provider,
      model: this.model,
      voice: this.voice,
      language: this.language,
      sampleRate: this.sampleRate,
      encoding: this.encoding,
    };
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `${key}.${randomUUID()}.tmp`);
    try {
      await writeFile(tmp, JSON.stringify(entry));
      await rename(tmp, join(dir, `${key}.json`));
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    this.diskKeys.add(key);
  }

  /**
   * Best-effort fill of missing phrases within a total deadline.
   * Never throws. Returns { filled, failed }. Stops starting new work once the deadline passes.
   * `deadlineMs` is a duration budget measured from the start of this call.
   */
  async prewarm(
    texts: string[],
    synth: (text: string) => Promise<Buffer>,
    deadlineMs: number,
  ): Promise<{ filled: number; failed: number }> {
    const started = Date.now();
    const deadline = started + deadlineMs;
    let filled = 0;
    let failed = 0;
    for (const text of texts) {
      if (Date.now() >= deadline) break;
      if (this.entries.has(this.key(text))) continue;
      try {
        const audio = Buffer.from(await synth(text));
        this.set(text, audio);
        filled += 1;
      } catch (err) {
        failed += 1;
        this.trace({ component: 'fixed-audio', event: 'prewarm-error', key: this.key(text), detail: describe(err) });
      }
    }
    const result = { filled, failed };
    this.trace({ component: 'fixed-audio', event: 'prewarm', ...result, ms: Date.now() - started });
    return result;
  }

  stats(): { entries: number; hits: number; misses: number; diskEntries: number } {
    return {
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      diskEntries: this.diskKeys.size,
    };
  }

  clear(): void {
    this.entries.clear();
    this.diskKeys.clear();
    this.hits = 0;
    this.misses = 0;
  }

  private readEntry(file: string, raw: string): { key: string; audio: Buffer } | undefined {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (typeof value !== 'object' || value === null) return undefined;
    const entry = value as Record<string, unknown>;
    if (entry['v'] !== FORMAT_VERSION) return undefined;
    if (typeof entry['text'] !== 'string') return undefined;
    const key = this.key(entry['text']);
    if (file !== `${key}.json`) return undefined;
    if (
      entry['provider'] !== this.provider ||
      entry['model'] !== this.model ||
      entry['voice'] !== this.voice ||
      entry['language'] !== this.language ||
      entry['sampleRate'] !== this.sampleRate ||
      entry['encoding'] !== this.encoding
    ) {
      return undefined;
    }
    const audio = decodeBase64(entry['audio']);
    if (!audio) return undefined;
    return { key, audio };
  }

  private trace(event: TraceEvent): void {
    try {
      this.onTrace?.(event);
    } catch {}
  }
}
