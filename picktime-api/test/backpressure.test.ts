import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.ts';
import { createClient } from '../src/client.ts';
import { MemoryDriver } from '../src/memoryDriver.ts';
import { Pool } from '../src/pool.ts';

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function listen(
  options: {
    driver?: MemoryDriver;
    pool?: Pool;
    events?: Array<Record<string, unknown>>;
    staffId?: string;
  } = {},
): Promise<{ base: string; driver: MemoryDriver; events: Array<Record<string, unknown>> }> {
  const driver = options.driver ?? new MemoryDriver();
  const events = options.events ?? [];
  const api = createApp({
    bearerKey: 'secret',
    checkReadiness: async () => {},
    logEvent: (e) => events.push(e),
    pageId: 'page-1',
    staffId: options.staffId ?? 'doc-veer',
    timeZone: 'Asia/Kolkata',
    driver,
    pool: options.pool ?? new Pool(4),
  }).listen(0);
  servers.push(api);
  const addr = api.address() as AddressInfo;
  return { base: `http://127.0.0.1:${addr.port}`, driver, events };
}

describe('backpressure, observability, and client', () => {
  it('caps browser concurrency with 429 plus Retry-After', async () => {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const driver = new MemoryDriver();
    const real = driver.getDirectory.bind(driver);
    driver.getDirectory = async () => {
      entered.resolve();
      await gate.promise;
      return real();
    };
    const events: Array<Record<string, unknown>> = [];
    const { base } = await listen({ driver, pool: new Pool(1), events });
    const headers = { authorization: 'Bearer secret' };
    const first = fetch(`${base}/v1/meta`, { headers });
    await entered.promise;
    const second = await fetch(`${base}/v1/meta`, { headers });
    assert.equal(second.status, 429);
    assert.equal(second.headers.get('retry-after'), '1');
    assert.equal(((await second.json()) as { error: string }).error, 'pool-full');
    gate.resolve();
    assert.equal((await first).status, 200);
    assert.ok(events.some((e) => e.reason === 'pool-full' && e.pageId === 'page-1'));
  });

  it('surfaces page-down distinctly from slot and validation failures', async () => {
    const driver = new MemoryDriver({ down: true });
    const { base } = await listen({ driver });
    const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' };
    const meta = await fetch(`${base}/v1/meta`, { headers });
    assert.equal(meta.status, 502);
    assert.equal(((await meta.json()) as { error: string }).error, 'page-down');
    const hold = await fetch(`${base}/v1/holds`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ serviceId: 'svc-sample', slotStart: '2099-09-08T09:00:00' }),
    });
    assert.equal(hold.status, 502);
  });

  it('logs failures with page identity, reason, and slot while keeping patient data minimal', async () => {
    const events: Array<Record<string, unknown>> = [];
    const { base } = await listen({ events });
    const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' };
    await fetch(`${base}/v1/holds`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ serviceId: 'svc-sample', slotStart: '2099-09-13T09:00:00' }),
    });
    const failure = events.find((e) => e.kind === 'hold');
    assert.ok(failure);
    assert.equal(failure.pageId, 'page-1');
    assert.equal(failure.reason, 'invented-slot');

    const slots = (await (await fetch(`${base}/v1/slots?serviceId=svc-sample&from=2099-09-07&to=2099-09-11`, { headers })).json()) as {
      slots: Array<{ start: string }>;
    };
    await fetch(`${base}/v1/bookings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        serviceId: 'svc-sample',
        slotStart: slots.slots[0].start,
        patientName: 'Asha Secret',
        patientPhone: '+919999888777',
      }),
    });
    const dumped = JSON.stringify(events);
    assert.equal(dumped.includes('Asha Secret'), false);
    assert.equal(dumped.includes('+919999888777'), false);
  });

  it('publishes an OpenAPI document and books end-to-end through the typed client', async () => {
    const { base } = await listen();
    const client = createClient({ baseUrl: base, bearerKey: 'secret' });
    const doc = await client.openapi();
    assert.ok(doc.paths);
    assert.ok((doc.paths as Record<string, unknown>)['/v1/bookings']);

    const meta = await client.meta();
    const serviceId = meta.services[0].id;
    const found = await client.slots({ serviceId, from: '2099-09-07', to: '2099-09-11' });
    assert.ok(found.slots.length > 0);
    assert.equal(found.timeZone, 'Asia/Kolkata');
    const text = JSON.stringify(found);
    for (const banned of ['scanToken', 'browserId', 'csrf', 'slotBlocker', 'picktime.com']) {
      assert.equal(text.includes(banned), false);
    }
    const hold = await client.hold({ serviceId, slotStart: found.slots[0].start });
    await client.releaseHold(hold.holdId);
    const dry = await client.book({ serviceId, slotStart: found.slots[1].start, patientName: 'A', patientPhone: 'P', dryRun: true });
    assert.equal((dry as { saved: boolean }).saved, false);
    const booked = await client.book({
      serviceId,
      slotStart: found.slots[2].start,
      patientName: 'Asha',
      patientPhone: '+911234567890',
      idempotencyKey: 'client-e2e-1',
    });
    assert.ok('bookingId' in booked);
  });
});
