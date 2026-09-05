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
  overrides: { bearerKey?: string; checkReadiness?: () => Promise<void>; logEvent?: (e: Record<string, unknown>) => void } = {},
) {
  const server = createApp({
    bearerKey: overrides.bearerKey ?? 'secret',
    checkReadiness: overrides.checkReadiness ?? (async () => {}),
    logEvent: overrides.logEvent ?? (() => {}),
  }).listen(0);
  servers.push(server);
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;
  return {
    get: async (path: string, key?: string) => {
      const headers: Record<string, string> = {};
      if (key !== undefined) headers.authorization = `Bearer ${key}`;
      const res = await fetch(`${url}${path}`, { headers });
      const text = await res.text();
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = { raw: text };
      }
      return { status: res.status, body };
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

describe('auth', () => {
  it('rejects versioned calls without a bearer key and routes them with one', async () => {
    const api = await start();
    assert.equal((await api.get('/v1/nope')).status, 401);
    assert.equal((await api.get('/v1/nope', 'wrong')).status, 401);
    assert.equal((await api.get('/v1/nope', 'secret')).status, 404);
  });
});
