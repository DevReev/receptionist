import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeMulaw, encodeWav } from '../src/audio.ts';
import { buildFixturesFromCapture, fixtureFromCapture } from '../src/capture.ts';

const dirs: string[] = [];

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('fixture capture', () => {
  it('converts an 8 kHz WAV utterance into mu-law bytes plus metadata', () => {
    const samples = new Int16Array([0, 1000, -1000, 2000]);
    const fixture = fixtureFromCapture(
      { callSid: 'CA123', turn: 4, text: 'my name is Asha', capturedAt: '2026-09-12T00:00:00.000Z' },
      encodeWav(samples, 8000),
    );
    assert.equal(fixture.name, 'CA123-turn4');
    assert.deepEqual(fixture.mulaw, encodeMulaw(samples));
    assert.equal(fixture.meta.reference, 'my name is Asha');
    assert.deepEqual(fixture.meta.fields, {});
    assert.deepEqual(fixture.meta.source, { callSid: 'CA123', turn: 4 });
  });

  it('rejects captures that are not 8 kHz telephony audio', () => {
    assert.throws(
      () => fixtureFromCapture({ callSid: 'CA1', turn: 1, text: 'hi' }, encodeWav(new Int16Array([1, 2]), 16000)),
      /capture-not-8khz/,
    );
  });

  it('builds fixture pairs and keeps existing files unless forced', async () => {
    const captureDir = await tmp('capture-');
    const outDir = await tmp('fixtures-');
    const wav = encodeWav(new Int16Array([0, 500, -500]), 8000);
    await writeFile(join(captureDir, 'CA1-turn1.wav'), wav);
    await writeFile(
      join(captureDir, 'CA1-turn1.json'),
      JSON.stringify({ callSid: 'CA1', turn: 1, text: 'book Wednesday' }),
    );
    // Sidecar without its WAV must be skipped, not fatal.
    await writeFile(
      join(captureDir, 'CA2-turn1.json'),
      JSON.stringify({ callSid: 'CA2', turn: 1, text: 'orphan' }),
    );
    await writeFile(join(captureDir, 'broken.json'), 'not-json{');

    const first = await buildFixturesFromCapture({ captureDir, outDir });
    assert.equal(first.written, 1);
    assert.equal(first.skipped, 2);
    assert.equal(first.warnings.length, 2);
    assert.deepEqual(first.names, ['CA1-turn1']);
    const built = (await readdir(outDir)).sort();
    assert.deepEqual(built, ['CA1-turn1.json', 'CA1-turn1.mulaw']);
    assert.deepEqual(Buffer.from(await readFile(join(outDir, 'CA1-turn1.mulaw'))), encodeMulaw(new Int16Array([0, 500, -500])));

    const second = await buildFixturesFromCapture({ captureDir, outDir });
    assert.equal(second.written, 0);
    assert.equal(second.skipped, 3);
    const forced = await buildFixturesFromCapture({ captureDir, outDir, overwrite: true });
    assert.equal(forced.written, 1);
  });
});
