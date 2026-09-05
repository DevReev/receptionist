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
    driver?: MemoryDriver;
    pool?: Pool;
    timeZone?: string;
  } = {},
) {
  const driver = options.driver ?? new MemoryDriver();
  const api = createApp({
    checkReadiness: async () => {},
    logEvent: () => {},
    pageId: 'page-1',
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
        headers: { ...(init?.headers ?? {}) },
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
  it('returns services, doctors, and locations with stable IDs and no page internals', async () => {
    const api = await start();
    const { status, body } = await api.fetch('/v1/meta');
    assert.equal(status, 200);
    assert.equal(body.timeZone, 'Asia/Kolkata');
    const services = body.services as Array<Record<string, unknown>>;
    const doctors = body.doctors as Array<Record<string, unknown>>;
    const locations = body.locations as Array<Record<string, unknown>>;
    assert.ok(services.length >= 1 && typeof services[0].id === 'string');
    assert.ok(doctors.length >= 1 && typeof doctors[0].id === 'string');
    assert.ok(locations.length > 1 && locations.every((l) => typeof l.id === 'string'));
    const text = JSON.stringify(body);
    assert.match(text, /svc-sample|doc-veer/);
    for (const banned of ['scanToken', 'browserId', 'csrf', 'slotBlocker', 'YYYYMMDDHHMM', 'picktime.com']) {
      assert.equal(text.includes(banned), false, `leaks page internal: ${banned}`);
    }
  });

  it('lists slots as ISO local with timezone, omitting past times', async () => {
    const api = await start();
    const { from, to } = futureWindow();
    const meta = (await api.fetch('/v1/meta')).body;
    const serviceId = (meta.services as Array<{ id: string }>)[0].id;
    const doctorIds = new Set((meta.doctors as Array<{ id: string }>).map((d) => d.id));
    const locationIds = new Set((meta.locations as Array<{ id: string }>).map((l) => l.id));
    const { status, body } = await api.fetch(
      `/v1/get_available_slots?serviceId=${serviceId}&from=${from}&to=${to}`, 
    );
    assert.equal(status, 200);
    assert.equal(body.timeZone, 'Asia/Kolkata');
    const slots = body.slots as Array<{ start: string; doctorId: string; locationId: string }>;
    assert.ok(slots.length > 0);
    assert.match(slots[0].start, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/);
    assert.ok(slots.every((s) => doctorIds.has(s.doctorId)));
    assert.ok(slots.every((s) => locationIds.has(s.locationId)));
  });


  it('keeps per-doctor per-location grouping when neither is passed', async () => {
    const api = await start();
    const { body } = await api.fetch('/v1/slots?serviceId=svc-sample&from=2099-09-07&to=2099-09-11');
    const slots = body.slots as Array<{ doctorId: string; locationId: string }>;
    const seenDoctors = new Set(slots.map((s) => s.doctorId));
    const seenLocations = new Set(slots.map((s) => s.locationId));
    assert.ok(seenDoctors.size > 1, `expected grouped doctors, saw ${[...seenDoctors]}`);
    assert.ok(seenLocations.size > 1, `expected grouped locations, saw ${[...seenLocations]}`);
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

  it('rejects unknown service, doctor, and location IDs', async () => {
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
    const { status: s3, body: b3 } = await api.fetch(
      '/v1/slots?serviceId=svc-sample&locationId=nope&from=2099-09-07&to=2099-09-11',
    );
    assert.equal(s3, 404);
    assert.equal(b3.error, 'unknown-location');
  });
});
