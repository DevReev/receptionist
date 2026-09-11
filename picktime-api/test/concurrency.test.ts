import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapLimit, retryOnce } from '../src/concurrency.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('mapLimit', () => {
  it('caps in-flight work and preserves result order', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const results = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(10);
      inFlight -= 1;
      return n * 10;
    });
    assert.deepEqual(results, [10, 20, 30, 40, 50, 60, 70]);
    assert.equal(maxInFlight, 3);
  });

  it('runs every item even when the list is shorter than the limit', async () => {
    const results = await mapLimit(['a', 'b'], 8, async (s) => s.toUpperCase());
    assert.deepEqual(results, ['A', 'B']);
  });

  it('rejects with the first failure', async () => {
    await assert.rejects(
      () => mapLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
      /boom/,
    );
  });
});

describe('retryOnce', () => {
  it('returns the first success without retrying', async () => {
    let calls = 0;
    const out = await retryOnce(async () => {
      calls += 1;
      return 'ok';
    }, () => true);
    assert.equal(out, 'ok');
    assert.equal(calls, 1);
  });

  it('retries once when the failure is retryable', async () => {
    let calls = 0;
    const out = await retryOnce(async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return 'ok';
    }, () => true);
    assert.equal(out, 'ok');
    assert.equal(calls, 2);
  });

  it('does not retry non-retryable failures', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        retryOnce(async () => {
          calls += 1;
          throw new Error('fatal');
        }, () => false),
      /fatal/,
    );
    assert.equal(calls, 1);
  });
});
