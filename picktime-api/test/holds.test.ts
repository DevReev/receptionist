import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.ts';
import { MemoryDriver } from '../src/memoryDriver.ts';
import { Pool } from '../src/pool.ts';

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function start(options: { holdTtlMs?: number; heartbeatIntervalMs?: number } = {}) {
  const driver = new MemoryDriver();
  const api = createApp({
    bearerKey: 'secret',
    checkReadiness: async () => {},
    logEvent: () => {},
    pageId: 'page-1',
    staffId: 'doc-veer',
    timeZone: 'Asia/Kolkata',
    driver,
    pool: new Pool(4),
    holdTtlMs: options.holdTtlMs,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 60_000,
  }).listen(0);
  servers.push(api);
  const addr = api.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;
  const call = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = {};
    }
    return { status: res.status, body };
  };
  return { driver, call };
}

async function firstSlot(call: (path: string) => Promise<{ body: Record<string, unknown> }>): Promise<string> {
  const { body } = await call('/v1/slots?serviceId=svc-sample&from=2099-09-07&to=2099-09-11');
  const slots = body.slots as Array<{ start: string }>;
  assert.ok(slots.length > 0);
  return slots[0].start;
}

describe('holds and dry-run bookings', () => {
  it('holds a live slot and releases it on delete with no residue', async () => {
    const { driver, call } = await start();
    const slotStart = await firstSlot(call);
    const held = await call('/v1/holds', {
      method: 'POST',
      body: JSON.stringify({ serviceId: 'svc-sample', slotStart }),
    });
    assert.equal(held.status, 201);
    assert.ok(typeof held.body.holdId === 'string');
    assert.equal(held.body.slotStart, slotStart);
    assert.equal(driver.hasHoldFor('svc-sample', 'doc-veer', slotStart), true);
    const released = await call(`/v1/holds/${held.body.holdId}`, { method: 'DELETE' });
    assert.equal(released.status, 204);
    assert.equal(driver.hasHoldFor('svc-sample', 'doc-veer', slotStart), false);
    assert.equal((await call(`/v1/holds/${held.body.holdId}`, { method: 'DELETE' })).status, 404);
  });

  it('rejects invented times and elsewhere-held slots without holding', async () => {
    const { driver, call } = await start();
    const invented = await call('/v1/holds', {
      method: 'POST',
      body: JSON.stringify({ serviceId: 'svc-sample', slotStart: '2099-09-13T09:00:00' }),
    });
    assert.equal(invented.status, 422);
    assert.equal(invented.body.error, 'invented-slot');
    assert.equal(driver.hasHoldFor('svc-sample', 'doc-veer', '2099-09-13T09:00:00'), false);

    const slotStart = await firstSlot(call);
    assert.equal(
      (await call('/v1/holds', { method: 'POST', body: JSON.stringify({ serviceId: 'svc-sample', slotStart }) })).status,
      201,
    );
    const second = await call('/v1/holds', {
      method: 'POST',
      body: JSON.stringify({ serviceId: 'svc-sample', slotStart }),
    });
    assert.equal(second.status, 422);
    assert.equal(second.body.error, 'slot-taken');
  });

  it('expires abandoned holds server-side', async () => {
    // Integration: server owns its expiry setTimeout with no clock injection;
    // a genuine short delay is the only way to observe auto-release.
    const { driver, call } = await start({ holdTtlMs: 120, heartbeatIntervalMs: 50 });
    const slotStart = await firstSlot(call);
    const held = await call('/v1/holds', {
      method: 'POST',
      body: JSON.stringify({ serviceId: 'svc-sample', slotStart }),
    });
    assert.equal(held.status, 201);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 350);
    await promise;
    assert.equal(driver.hasHoldFor('svc-sample', 'doc-veer', slotStart), false);
    assert.equal((await call(`/v1/holds/${held.body.holdId}`, { method: 'DELETE' })).status, 404);
  });

  it('dry runs hold then release without ever saving', async () => {
    const { driver, call } = await start();
    const slotStart = await firstSlot(call);
    const dry = await call('/v1/bookings', {
      method: 'POST',
      body: JSON.stringify({ serviceId: 'svc-sample', slotStart, dryRun: true }),
    });
    assert.equal(dry.status, 200);
    assert.equal(dry.body.dryRun, true);
    assert.equal(dry.body.held, true);
    assert.equal(dry.body.saved, false);
    assert.equal(driver.hasHoldFor('svc-sample', 'doc-veer', slotStart), false);
    const held = await call('/v1/holds', {
      method: 'POST',
      body: JSON.stringify({ serviceId: 'svc-sample', slotStart }),
    });
    assert.equal(held.status, 201);
  });
});
