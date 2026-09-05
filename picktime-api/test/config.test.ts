import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';

describe('config', () => {
  it('fails fast listing every missing credential', () => {
    assert.throws(() => loadConfig({}), /PICKTIME_PAGE_ID.*API_BEARER_KEY|API_BEARER_KEY.*PICKTIME_PAGE_ID/);
  });

  it('applies documented defaults for port, timezone, pool, and timeouts', () => {
    const cfg = loadConfig({ PICKTIME_PAGE_ID: 'page-1', API_BEARER_KEY: 'secret' });
    assert.equal(cfg.port, 3000);
    assert.equal(cfg.timeZone, 'Asia/Kolkata');
    assert.equal(cfg.poolSize, 4);
    assert.equal(cfg.pageId, 'page-1');
    assert.equal(cfg.bearerKey, 'secret');
  });
});
