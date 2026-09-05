import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatLogLine } from '../src/log.ts';

describe('log line', () => {
  it('is a JSON line carrying timestamped fields', () => {
    const parsed = JSON.parse(
      formatLogLine({ kind: 'ready', pageId: 'page-1' }),
    ) as Record<string, unknown>;
    assert.equal(parsed.kind, 'ready');
    assert.equal(parsed.pageId, 'page-1');
    assert.equal(typeof parsed.ts, 'string');
  });
});
