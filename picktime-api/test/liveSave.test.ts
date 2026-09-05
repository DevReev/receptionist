import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.ts';
import { createClient } from '../src/client.ts';
import { PlaywrightDriver } from '../src/playwrightDriver.ts';
import { Pool } from '../src/pool.ts';

/**
 * Live-save suite. NEVER runs by default. Every run books a REAL appointment
 * plus confirmation email needing manual cleanup (no cancel flow in v1).
 * Run only by director decision with explicit opt-in and page identity:
 *   PICKTIME_LIVE_SAVE=1 PICKTIME_PAGE_ID=<page> PICKTIME_TEST_PHONE=+91... npm test -- test/liveSave.test.ts
 */
const GATED = process.env.PICKTIME_LIVE_SAVE === '1';
const PAGE_ID = process.env.PICKTIME_PAGE_ID ?? '';
const TEST_PHONE = process.env.PICKTIME_TEST_PHONE ?? '';

const servers: Server[] = [];
const drivers: PlaywrightDriver[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  for (const driver of drivers.splice(0)) await driver.close();
});

describe('live save (explicit opt-in only)', () => {
  it('books a real appointment exactly once on retry', { skip: !GATED }, async () => {
    assert.ok(PAGE_ID, 'PICKTIME_PAGE_ID is required');
    assert.ok(TEST_PHONE, 'PICKTIME_TEST_PHONE is required');
    const driver = new PlaywrightDriver({ pageId: PAGE_ID });
    drivers.push(driver);
    const api = createApp({
      bearerKey: 'secret',
      checkReadiness: () => driver.checkHealth(),
      logEvent: (e) => console.log(JSON.stringify(e)),
      pageId: PAGE_ID,
      timeZone: 'Asia/Kolkata',
      driver,
      pool: new Pool(1),
    }).listen(0);
    servers.push(api);
    const addr = api.address() as AddressInfo;
    const client = createClient({ baseUrl: `http://127.0.0.1:${addr.port}`, bearerKey: 'secret' });
    const meta = await client.meta();
    const from = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 25 * 86_400_000).toISOString().slice(0, 10);
    const found = await client.slots({ serviceId: meta.services[0].id, from, to });
    assert.ok(found.slots.length > 0);
    const slotStart = found.slots[0].start;
    const key = `live-save-${Date.now()}`;
    const first = await client.book({
      serviceId: meta.services[0].id,
      slotStart,
      patientName: 'Tool API Test',
      patientPhone: TEST_PHONE,
      idempotencyKey: key,
    });
    assert.ok('bookingId' in first);
    const replay = await client.book({
      serviceId: meta.services[0].id,
      slotStart,
      patientName: 'Tool API Test',
      patientPhone: TEST_PHONE,
      idempotencyKey: key,
    });
    assert.deepEqual(replay, first);
  });
});
