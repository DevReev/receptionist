import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.ts';

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function start(
  overrides: { checkReadiness?: () => Promise<void>; logEvent?: (e: Record<string, unknown>) => void; rateLimitPerMinute?: number } = {},
) {
  const server = createApp({
    checkReadiness: overrides.checkReadiness ?? (async () => {}),
    logEvent: overrides.logEvent ?? (() => {}),
    rateLimitPerMinute: overrides.rateLimitPerMinute,
  }).listen(0);
  servers.push(server);
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;
  return {
    get: async (path: string) => {
      const res = await fetch(`${url}${path}`);
      const text = await res.text();
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = { raw: text };
      }
      return { status: res.status, body, headers: res.headers };
    },
  };
}

describe('health', () => {
  it('reports ok without a key', async () => {
    const api = await start();
    const { status, body } = await api.get('/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
  });
  it('reports degraded without leaking internals and logs the cause', async () => {
    const events: Record<string, unknown>[] = [];
    const api = await start({
      checkReadiness: async () => {
        throw new Error('browser down');
      },
      logEvent: (e) => events.push(e),
    });
    const { status, body } = await api.get('/health');
    assert.equal(status, 503);
    assert.equal(body.status, 'degraded');
    assert.equal('reason' in body, false);
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, 'browser down');
  });
});

describe('public API', () => {
  it('routes versioned calls without credentials', async () => {
    const api = await start();
    assert.equal((await api.get('/v1/nope')).status, 404);
  });

  it('rate-limits public versioned calls and provides retry guidance', async () => {
    const api = await start({ rateLimitPerMinute: 1 });
    assert.equal((await api.get('/v1/nope')).status, 404);
    const limited = await api.get('/v1/nope');
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get('retry-after'));
  });
});
