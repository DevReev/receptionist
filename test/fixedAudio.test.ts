import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixedAudioCache } from '../src/fixedAudio.ts';
import type { FixedAudioCacheOptions } from '../src/fixedAudio.ts';
import type { TraceEvent } from '../src/trace.ts';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fixed-audio-'));
  dirs.push(dir);
  return dir;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function options(overrides: Partial<FixedAudioCacheOptions> = {}): FixedAudioCacheOptions {
  return {
    provider: 'sarvam',
    model: 'bulbul:v2',
    voice: 'anushka',
    language: 'en-IN',
    sampleRate: 8000,
    encoding: 'audio/x-mulaw',
    ...overrides,
  };
}

function entryFor(text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    text,
    audio: Buffer.from('audio').toString('base64'),
    provider: 'sarvam',
    model: 'bulbul:v2',
    voice: 'anushka',
    language: 'en-IN',
    sampleRate: 8000,
    encoding: 'audio/x-mulaw',
    ...overrides,
  };
}

describe('FixedAudioCache keys', () => {
  it('builds a stable v1 sha256-prefixed key', () => {
    const a = new FixedAudioCache(options());
    const b = new FixedAudioCache(options());
    assert.match(a.key('hello'), /^v1-[0-9a-f]{32}$/);
    assert.equal(a.key('hello'), b.key('hello'));
  });

  it('changes the key with text or any metadata field', () => {
    const base = new FixedAudioCache(options());
    const key = base.key('hello');
    const variants: Partial<FixedAudioCacheOptions>[] = [
      { provider: 'openai' },
      { model: 'other' },
      { voice: 'other' },
      { language: 'hi-IN' },
      { sampleRate: 24000 },
      { encoding: 'audio/pcm' },
    ];
    for (const variant of variants) {
      assert.notEqual(key, new FixedAudioCache(options(variant)).key('hello'));
    }
    assert.notEqual(key, base.key('hello there'));
    assert.notEqual(key, base.key('Hello'));
  });
});

describe('FixedAudioCache memory', () => {
  it('round-trips audio with defensive copies and tracks hits and misses', () => {
    const cache = new FixedAudioCache(options());
    const audio = Buffer.from([1, 2, 3]);
    cache.set('hello', audio);
    audio[0] = 99;
    const first = cache.get('hello');
    assert.deepEqual([...first!], [1, 2, 3]);
    first![0] = 42;
    const second = cache.get('hello');
    assert.deepEqual([...second!], [1, 2, 3]);
    assert.equal(cache.get('missing'), undefined);
    assert.deepEqual(cache.stats(), { entries: 1, hits: 2, misses: 1, diskEntries: 0 });
  });

  it('clears entries and counters', () => {
    const cache = new FixedAudioCache(options());
    cache.set('hello', Buffer.from('audio'));
    cache.get('hello');
    cache.get('missing');
    cache.clear();
    assert.deepEqual(cache.stats(), { entries: 0, hits: 0, misses: 0, diskEntries: 0 });
    assert.equal(cache.get('hello'), undefined);
  });
});

describe('FixedAudioCache prewarm', () => {
  it('fills missing phrases, skips cached ones, counts failures, and traces the outcome', async () => {
    const events: TraceEvent[] = [];
    const cache = new FixedAudioCache(options({ onTrace: (event) => events.push(event) }));
    cache.set('greeting', Buffer.from('cached'));
    const calls: string[] = [];
    const result = await cache.prewarm(
      ['greeting', 'holding', 'no-response'],
      async (text) => {
        calls.push(text);
        if (text === 'no-response') throw new Error('synth-down');
        return Buffer.from(`audio:${text}`);
      },
      10_000,
    );
    assert.deepEqual(calls, ['holding', 'no-response']);
    assert.deepEqual(result, { filled: 1, failed: 1 });
    assert.equal(cache.get('holding')!.toString(), 'audio:holding');
    assert.equal(cache.get('no-response'), undefined);
    const outcome = events.find((event) => event.event === 'prewarm');
    assert.equal(outcome?.filled, 1);
    assert.equal(outcome?.failed, 1);
  });

  it('stops starting new work once the deadline passes', async () => {
    const cache = new FixedAudioCache(options());
    const calls: string[] = [];
    const result = await cache.prewarm(
      ['one', 'two', 'three'],
      async (text) => {
        calls.push(text);
        if (text === 'one') await sleep(60);
        return Buffer.from(text);
      },
      25,
    );
    assert.deepEqual(calls, ['one']);
    assert.deepEqual(result, { filled: 1, failed: 0 });
  });

  it('does no work when the deadline has already passed', async () => {
    const cache = new FixedAudioCache(options());
    let calls = 0;
    const result = await cache.prewarm(
      ['one', 'two'],
      async () => {
        calls += 1;
        return Buffer.from('x');
      },
      0,
    );
    assert.equal(calls, 0);
    assert.deepEqual(result, { filled: 0, failed: 0 });
  });
});

describe('FixedAudioCache disk', () => {
  it('persists an entry and loads it into a fresh cache', async () => {
    const dir = await tempDir();
    const events: TraceEvent[] = [];
    const cache = new FixedAudioCache(options({ dir }));
    const audio = Buffer.from([7, 8, 9]);
    cache.set('hello world', audio);
    await cache.saveToDisk('hello world');
    assert.equal(cache.stats().diskEntries, 1);

    const entry = JSON.parse(await readFile(join(dir, `${cache.key('hello world')}.json`), 'utf8')) as Record<
      string,
      unknown
    >;
    assert.equal(entry['v'], 1);
    assert.equal(entry['text'], 'hello world');
    assert.equal(entry['audio'], audio.toString('base64'));
    assert.equal(entry['provider'], 'sarvam');
    assert.equal(entry['model'], 'bulbul:v2');
    assert.equal(entry['voice'], 'anushka');
    assert.equal(entry['language'], 'en-IN');
    assert.equal(entry['sampleRate'], 8000);
    assert.equal(entry['encoding'], 'audio/x-mulaw');

    const fresh = new FixedAudioCache(options({ dir, onTrace: (event) => events.push(event) }));
    assert.equal(await fresh.loadFromDisk(), 1);
    assert.deepEqual([...fresh.get('hello world')!], [7, 8, 9]);
    assert.equal(fresh.stats().diskEntries, 1);
    const load = events.find((event) => event.event === 'load');
    assert.equal(load?.component, 'fixed-audio');
    assert.equal(load?.count, 1);
  });

  it('creates the cache directory when saving', async () => {
    const root = await tempDir();
    const dir = join(root, 'nested', 'cache');
    const cache = new FixedAudioCache(options({ dir }));
    cache.set('hello', Buffer.from('audio'));
    await cache.saveToDisk('hello');
    const fresh = new FixedAudioCache(options({ dir }));
    assert.equal(await fresh.loadFromDisk(), 1);
    assert.equal(fresh.get('hello')!.toString(), 'audio');
  });

  it('is a no-op for saving when dir is unset', async () => {
    const cache = new FixedAudioCache(options());
    cache.set('hello', Buffer.from('audio'));
    await cache.saveToDisk('hello');
    await cache.saveToDisk('never-cached');
    assert.equal(cache.stats().diskEntries, 0);
  });

  it('ignores corrupt and unsupported files', async () => {
    const dir = await tempDir();
    const cache = new FixedAudioCache(options({ dir }));
    await writeFile(join(dir, 'broken.json'), '{ definitely not json');
    await writeFile(join(dir, 'notes.txt'), 'ignore me');
    await writeFile(join(dir, `${cache.key('bad')}.json`), JSON.stringify(entryFor('bad', { audio: 'not base64!!' })));
    assert.equal(await cache.loadFromDisk(), 0);
    assert.equal(cache.get('bad'), undefined);
  });

  it('ignores entries whose filename or metadata does not match', async () => {
    const dir = await tempDir();
    const cache = new FixedAudioCache(options({ dir }));
    const text = 'hello';
    await writeFile(join(dir, `${cache.key(text)}.json`), JSON.stringify(entryFor(text, { provider: 'other' })));
    await writeFile(join(dir, `${cache.key('other text')}.json`), JSON.stringify(entryFor(text)));
    assert.equal(await cache.loadFromDisk(), 0);
    assert.equal(cache.get(text), undefined);
  });

  it('ignores entries from a different producer identity', async () => {
    const dir = await tempDir();
    const writer = new FixedAudioCache(options({ dir }));
    writer.set('hello', Buffer.from('audio'));
    await writer.saveToDisk('hello');
    const other = new FixedAudioCache(options({ dir, voice: 'someone-else' }));
    assert.equal(await other.loadFromDisk(), 0);
    assert.equal(other.get('hello'), undefined);
  });

  it('returns zero when the directory is missing', async () => {
    const root = await tempDir();
    const cache = new FixedAudioCache(options({ dir: join(root, 'absent') }));
    assert.equal(await cache.loadFromDisk(), 0);
  });

  it('traces persistence failures instead of rejecting', async () => {
    const root = await tempDir();
    const blocker = join(root, 'blocker');
    await writeFile(blocker, 'file');
    const events: TraceEvent[] = [];
    const cache = new FixedAudioCache(
      options({ dir: join(blocker, 'cache'), onTrace: (event) => events.push(event) }),
    );
    cache.set('hello', Buffer.from('audio'));
    await sleep(50);
    assert.ok(events.some((event) => event.event === 'save-error'));
  });
});
