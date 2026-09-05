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

async function start(
  options: {
    staffId?: string;
    driver?: MemoryDriver;
    pool?: Pool;
    timeZone?: string;
  } = {},
) {
  const driver = options.driver ?? new MemoryDriver();
  const api = createApp({
    bearerKey: 'secret',
    checkReadiness: async () => {},
    logEvent: () => {},
    pageId: 'page-1',
    staffId: options.staffId ?? 'doc-veer',
    timeZone: options.timeZone ?? 'Asia/Kolkata',
    driver,
    pool: options.pool ?? new Pool(4),
  }).listen(0);
  servers.push(api);
  const addr = api.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;
  return {
    driver,
    fetch: async (path: string, init?: RequestInit) => {
      const res = await fetch(`${base}${path}`, {
        ...init,
        headers: { authorization: 'Bearer secret', ...(init?.headers ?? {}) },
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: res.status, body, headers: res.headers };
    },
  };
}

function futureWindow(daysFromNow = 30): { from: string; to: string } {
  const fromDate = new Date(Date.now() + daysFromNow * 86_400_000);
  const toDate = new Date(fromDate.getTime() + 6 * 86_400_000);
  return { from: fromDate.toISOString().slice(0, 10), to: toDate.toISOString().slice(0, 10) };
}

describe('directory and slot listing', () => {
  it('returns services, doctors, and location with stable IDs and no page internals', async () => {
    const api = await start();
    const { status, body } = await api.fetch('/v1/meta');
    assert.equal(status, 200);
    assert.equal(body.timeZone, 'Asia/Kolkata');
    const services = body.services as Array<Record<string, unknown>>;
    const doctors = body.doctors as Array<Record<string, unknown>>;
    assert.ok(services.length >= 1 && typeof services[0].id === 'string');
    assert.ok(doctors.length >= 1 && typeof doctors[0].id === 'string');
    assert.ok((body.location as Record<string, unknown>).id);
    const text = JSON.stringify(body);
    assert.match(text, /svc-sample|doc-veer/);
    for (const banned of ['scanToken', 'browserId', 'csrf', 'slotBlocker', 'YYYYMMDDHHMM', 'picktime.com']) {
      assert.equal(text.includes(banned), false, `leaks page internal: ${banned}`);
    }
  });

  it('lists slots as ISO local with timezone, omitting past times', async () => {
    const api = await start();
    const { from, to } = futureWindow();
    const serviceId = ((await api.fetch('/v1/meta')).body.services as Array<{ id: string }>)[0].id;
    const { status, body } = await api.fetch(
      `/v1/slots?serviceId=${serviceId}&from=${from}&to=${to}`,
    );
    assert.equal(status, 200);
    assert.equal(body.timeZone, 'Asia/Kolkata');
    const slots = body.slots as Array<{ start: string; doctorId: string }>;
    assert.ok(slots.length > 0);
    assert.match(slots[0].start, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/);
    assert.equal(slots[0].doctorId, 'doc-veer');
  });

  it('resolves an absent doctor to the configured single doctor', async () => {
    const api = await start({ staffId: 'doc-veer2' });
    const { from, to } = futureWindow();
    const { body } = await api.fetch(`/v1/slots?serviceId=svc-sample&from=${from}&to=${to}`);
    const slots = body.slots as Array<{ doctorId: string }>;
    assert.ok(slots.length > 0);
    assert.ok(slots.every((s) => s.doctorId === 'doc-veer2'));
  });

  it('keeps per-doctor grouping when no doctor is configured', async () => {
    const api = await start({ staffId: undefined });
    const app2 = createApp({
      bearerKey: 'secret',
      checkReadiness: async () => {},
      logEvent: () => {},
      pageId: 'page-1',
      timeZone: 'Asia/Kolkata',
      driver: api.driver,
      pool: new Pool(4),
    }).listen(0);
    servers.push(app2);
    const addr = app2.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/slots?serviceId=svc-sample&from=2099-09-07&to=2099-09-11`, {
      headers: { authorization: 'Bearer secret' },
    });
    const body = (await res.json()) as { slots: Array<{ doctorId: string }> };
    const seen = new Set(body.slots.map((s) => s.doctorId));
    assert.ok(seen.size > 1, `expected grouped doctors, saw ${[...seen]}`);
  });

  it('returns an explicit none-available reason instead of an ambiguous empty reply', async () => {
    const api = await start();
    const { status, body } = await api.fetch(
      '/v1/slots?serviceId=svc-sample&from=2099-09-12&to=2099-09-13',
    );
    assert.equal(status, 200);
    assert.deepEqual(body.slots, []);
    assert.equal(body.reason, 'none-available');
  });
  it('omits past times from windows that include today', async () => {
    const api = await start();
    const today = new Date().toISOString().slice(0, 10);
    const later = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const { body } = await api.fetch(
      `/v1/slots?serviceId=svc-sample&from=${today}&to=${later}`,
    );
    const slots = body.slots as Array<{ start: string }>;
    for (const s of slots) assert.ok(s.start >= `${today}T00:00:00`);
    const past = await api.fetch('/v1/slots?serviceId=svc-sample&from=2000-01-03&to=2000-01-07');
    assert.deepEqual(past.body.slots, []);
    assert.equal(past.body.reason, 'none-available');
  });


  it('caps windows at one month and requires service and valid dates', async () => {
    const api = await start();
    assert.equal((await api.fetch('/v1/slots?from=2099-09-01&to=2099-09-07')).status, 422);
    assert.equal(
      (await api.fetch('/v1/slots?serviceId=svc-sample&from=2099-09-01&to=2099-10-15')).status,
      422,
    );
    assert.equal(
      (await api.fetch('/v1/slots?serviceId=svc-sample&from=not-a-date&to=2099-09-07')).status,
      422,
    );
  });

  it('rejects unknown service and doctor IDs', async () => {
    const api = await start();
    const { status: s1, body: b1 } = await api.fetch(
      '/v1/slots?serviceId=nope&from=2099-09-07&to=2099-09-11',
    );
    assert.equal(s1, 404);
    assert.equal(b1.error, 'unknown-service');
    const { status: s2, body: b2 } = await api.fetch(
      '/v1/slots?serviceId=svc-sample&doctorId=nope&from=2099-09-07&to=2099-09-11',
    );
    assert.equal(s2, 404);
    assert.equal(b2.error, 'unknown-doctor');
  });
});
