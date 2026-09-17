import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  benchmarkFixture,
  fieldMatches,
  percentile,
  replayUtterance,
  summarize,
  wordErrorRate,
  type ReplayTarget,
} from '../src/benchmark.ts';

describe('benchmark metrics', () => {
  it('computes nearest-rank percentiles', () => {
    assert.equal(percentile([], 50), 0);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
    assert.equal(percentile([5, 1, 3], 50), 3);
  });

  it('computes word error rate', () => {
    assert.equal(wordErrorRate('book an appointment', 'book an appointment'), 0);
    assert.equal(wordErrorRate('book an appointment', 'book appointment'), 1 / 3);
    assert.equal(wordErrorRate('book', 'book a time'), 2);
    assert.equal(wordErrorRate('', ''), 0);
    assert.equal(wordErrorRate('', 'unexpected'), 1);
  });

  it('matches critical fields separately from the transcript', () => {
    const matches = fieldMatches(
      { name: 'Asha Ravi', phone: '+91 98409 50950' },
      'my name is asha ravi and the number is 9840950950',
    );
    assert.deepEqual(matches, { name: true, phone: true });
    assert.deepEqual(fieldMatches({ phone: '9840950950' }, 'number is 9840950951'), { phone: false });
  });
});

describe('paced replay', () => {
  it('feeds 20 ms frames with real pacing and measures last-speech to final', async () => {
    const frames: number[] = [];
    let clock = 0;
    const target: ReplayTarget = {
      pushAudio: (frame) => frames.push(frame.length),
      speechStart: () => {},
      finalize: async () => {
        clock += 140;
        return { text: 'ok', noSpeech: false };
      },
      close: () => {},
    };
    const audio = Buffer.alloc(160 * 3, 0xff);
    const result = await replayUtterance(target, audio, {
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    assert.deepEqual(frames, [160, 160, 160]);
    assert.equal(result.frames, 3);
    assert.equal(result.lastSpeechToFinalMs, 140);
  });

  it('reports per-fixture WER and fields, then aggregates percentiles', async () => {
    const target: ReplayTarget = {
      pushAudio: () => {},
      speechStart: () => {},
      finalize: async () => ({ text: 'book an appointment for asha', noSpeech: false }),
      close: () => {},
    };
    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) =>
        benchmarkFixture(
          target,
          {
            name: `fixture-${n}`,
            audio: Buffer.alloc(320, 0xff),
            reference: 'book an appointment for asha',
            fields: { name: 'Asha' },
          },
          { frameMs: 0 },
        ),
      ),
    );
    assert.equal(results[0]!.wer, 0);
    assert.deepEqual(results[0]!.fields, { name: true });
    const summary = summarize('saaras:v3-realtime:fast', results);
    assert.equal(summary.utterances, 10);
    assert.equal(summary.meanWer, 0);
    assert.equal(summary.fieldAccuracy, 1);
    assert.equal(summary.latency.p50 >= 0, true);
  });
});
