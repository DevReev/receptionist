import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.ts';
import { MemoryDriver } from '../src/memoryDriver.ts';
import type { PicktimeDriver } from '../src/driver.ts';
import { Pool } from '../src/pool.ts';

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function start(options: { staffId?: string; driver?: PicktimeDriver } = {}) {
  const driver = options.driver ?? new MemoryDriver();
  const api = createApp({
    bearerKey: 'secret',
    checkReadiness: async () => {},
    logEvent: () => {},
    pageId: 'page-1',
    staffId: options.staffId ?? 'doc-veer',
    timeZone: 'Asia/Kolkata',
    driver,
    pool: new Pool(4),
  }).listen(0);
  servers.push(api);
  const addr = api.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;
  const call = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body, headers: res.headers };
  };
  return { driver, call };
}

async function slotFor(call: (path: string) => Promise<{ body: Record<string, unknown> }>, from = '2099-09-07'): Promise<string> {
  const to = '2099-09-11';
  const { body } = await call(`/v1/slots?serviceId=svc-sample&from=${from}&to=${to}`);
  const slots = body.slots as Array<{ start: string }>;
  assert.ok(slots.length > 0);
  return slots[0].start;
}

class StrictContactDriver extends MemoryDriver {
  override async getDirectory(): Promise<Awaited<ReturnType<MemoryDriver['getDirectory']>>> {
    const directory = await super.getDirectory();
    return { ...directory, requiredContactFields: ['firstName', 'email'] };
  }
}

describe('confirm bookings with guardrails and idempotency', () => {
  it('confirms with service, slot, patient name and phone in one call', async () => {
    const { call } = await start();
    const slotStart = await slotFor(call);
    const { status, body } = await call('/v1/bookings', {
      method: 'POST',
      body: JSON.stringify({ serviceId: 'svc-sample', slotStart, patientName: 'Asha', patientPhone: '+911234567890' }),
    });
    assert.equal(status, 201);
    assert.ok(typeof body.bookingId === 'string');
    assert.equal(body.slotStart, slotStart);
    assert.equal(body.timeZone, 'Asia/Kolkata');
  });

  it('enforces phone server-side even though page prefs call it optional', async () => {
    const { call } = await start();
    const slotStart = await slotFor(call);
    const noPhone = await call('/v1/bookings', {
      method: 'POST',
      body: JSON.stringify({ serviceId: 'svc-sample', slotStart, patientName: 'Asha' }),
    });
    assert.equal(noPhone.status, 422);
    const noName = await call('/v1/bookings', {
      method: 'POST',
      body: JSON.stringify({ serviceId: 'svc-sample', slotStart, patientPhone: '+911234567890' }),
    });
    assert.equal(noName.status, 422);
  });

  it('rejects hallucinated slots and double-books with distinct codes', async () => {
    const { call } = await start();
    const invented = await call('/v1/bookings', {
      method: 'POST',
      body: JSON.stringify({
        serviceId: 'svc-sample',
        slotStart: '2099-09-13T09:00:00',
        patientName: 'Asha',
        patientPhone: '+911234567890',
      }),
    });
    assert.equal(invented.status, 422);
    assert.equal(invented.body.error, 'invented-slot');

    const slotStart = await slotFor(call);
    const first = await call('/v1/bookings', {
      method: 'POST',
      body: JSON.stringify({ serviceId: 'svc-sample', slotStart, patientName: 'Asha', patientPhone: '+911111111111' }),
    });
    assert.equal(first.status, 201);
    const taken = await call('/v1/bookings', {
      method: 'POST',
      body: JSON.stringify({ serviceId: 'svc-sample', slotStart, patientName: 'Ravi', patientPhone: '+912222222222' }),
    });
    assert.equal(taken.status, 422);
    assert.equal(taken.body.error, 'slot-taken');
  });

  it('replays retried confirmations instead of double-booking', async () => {
    const { call } = await start();
    const slotStart = await slotFor(call);
    const payload = { serviceId: 'svc-sample', slotStart, patientName: 'Asha', patientPhone: '+913333333333' };
    const first = await call('/v1/bookings', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json', 'idempotency-key': 'key-1' },
      body: JSON.stringify(payload),
    });
    assert.equal(first.status, 201);
    const replay = await call('/v1/bookings', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json', 'idempotency-key': 'key-1' },
      body: JSON.stringify(payload),
    });
    assert.equal(replay.status, 201);
    assert.deepEqual(replay.body, first.body);

    const natural = await call('/v1/bookings', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    assert.equal(natural.status, 201);
    assert.deepEqual(natural.body, first.body);

    const clash = await call('/v1/bookings', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json', 'idempotency-key': 'key-1' },
      body: JSON.stringify({ ...payload, patientName: 'Someone Else' }),
    });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error, 'conflict');
  });

  it('resolves absent doctor to the configured single doctor', async () => {
    const { call } = await start({ staffId: 'doc-veer2' });
    const { body } = await call('/v1/slots?serviceId=svc-sample&from=2099-09-07&to=2099-09-11');
    const slots = body.slots as Array<{ start: string; doctorId: string }>;
    assert.ok(slots.every((s) => s.doctorId === 'doc-veer2'));
    const booked = await call('/v1/bookings', {
      method: 'POST',
      body: JSON.stringify({ serviceId: 'svc-sample', slotStart: slots[0].start, patientName: 'Asha', patientPhone: '+914444444444' }),
    });
    assert.equal(booked.status, 201);
    assert.equal(booked.body.doctorId, 'doc-veer2');
  });

  it('fails ambiguous bookings as pick-a-doctor with candidates, never a silent default', async () => {
    const api = await start({ staffId: undefined });
    const driver = api.driver as MemoryDriver;
    void driver;
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
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/bookings`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        serviceId: 'svc-sample',
        slotStart: '2099-09-08T09:00:00',
        patientName: 'Asha',
        patientPhone: '+915555555555',
      }),
    });
    assert.equal(res.status, 422);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.error, 'pick-a-doctor');
    assert.ok(Array.isArray(body.candidates) && (body.candidates as unknown[]).length > 1);
  });

  it('re-reads live prefs and rejects newly-required missing fields', async () => {
    const { call } = await start({ driver: new StrictContactDriver() });
    const slotStart = await slotFor(call);
    const missing = await call('/v1/bookings', {
      method: 'POST',
      body: JSON.stringify({ serviceId: 'svc-sample', slotStart, patientName: 'Asha', patientPhone: '+916666666666' }),
    });
    assert.equal(missing.status, 422);
    const ok = await call('/v1/bookings', {
      method: 'POST',
      body: JSON.stringify({
        serviceId: 'svc-sample',
        slotStart,
        patientName: 'Asha',
        patientPhone: '+916666666666',
        email: 'asha@example.com',
      }),
    });
    assert.equal(ok.status, 201);
  });

  it('confirms a prior hold by id and rejects unknown holds', async () => {
    const { call } = await start();
    const slotStart = await slotFor(call);
    const held = await call('/v1/holds', {
      method: 'POST',
      body: JSON.stringify({ serviceId: 'svc-sample', slotStart }),
    });
    assert.equal(held.status, 201);
    const booked = await call('/v1/bookings', {
      method: 'POST',
      body: JSON.stringify({ holdId: held.body.holdId, patientName: 'Asha', patientPhone: '+917777777777' }),
    });
    assert.equal(booked.status, 201);
    assert.equal(booked.body.slotStart, slotStart);
    const unknown = await call('/v1/bookings', {
      method: 'POST',
      body: JSON.stringify({ holdId: 'nope', patientName: 'Asha', patientPhone: '+917777777777' }),
    });
    assert.equal(unknown.status, 404);
  });
});
