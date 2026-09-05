import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';

describe('config', () => {
  it('requires only the live Picktime page ID', () => {
    assert.throws(() => loadConfig({}), /PICKTIME_PAGE_ID/);
  });

  it('applies documented defaults for port, timezone, pool, timeouts, and rate limit', () => {
    const cfg = loadConfig({ PICKTIME_PAGE_ID: 'page-1' });
    assert.equal(cfg.port, 3000);
    assert.equal(cfg.timeZone, 'Asia/Kolkata');
    assert.equal(cfg.poolSize, 4);
    assert.equal(cfg.pageId, 'page-1');
    assert.equal(cfg.rateLimitPerMinute, 60);
  });
});
