import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.ts';
import { createClient, type Client } from '../src/client.ts';
import { PlaywrightDriver } from '../src/playwrightDriver.ts';
import { Pool } from '../src/pool.ts';

/**
 * Live page suites. Default runs stay offline-fast; these run only with:
 *   PICKTIME_LIVE=1 PICKTIME_PAGE_ID=<page uuid> npm test -- test/live.test.ts
 * Hold round-trips release immediately; only reads plus hold+release run here.
 * Real saves live behind test/liveSave.test.ts only, never here.
 */
const LIVE = process.env.PICKTIME_LIVE === '1';
const PAGE_ID = process.env.PICKTIME_PAGE_ID ?? '';

const servers: Server[] = [];
const drivers: PlaywrightDriver[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  for (const driver of drivers.splice(0)) await driver.close();
});

async function liveClient(): Promise<Client> {
  assert.ok(PAGE_ID, 'PICKTIME_PAGE_ID is required for live suites');
  const driver = new PlaywrightDriver({ pageId: PAGE_ID });
  drivers.push(driver);
  const api = createApp({
    bearerKey: 'secret',
    checkReadiness: () => driver.checkHealth(),
    logEvent: (e) => console.log(JSON.stringify(e)),
    pageId: PAGE_ID,
    timeZone: 'Asia/Kolkata',
    driver,
    pool: new Pool(2),
  }).listen(0);
  servers.push(api);
  const addr = api.address() as AddressInfo;
  return createClient({ baseUrl: `http://127.0.0.1:${addr.port}`, bearerKey: 'secret' });
}

function nextWeekdayWindow(): { from: string; to: string } {
  const from = new Date(Date.now() + 14 * 86_400_000);
  const to = new Date(from.getTime() + 4 * 86_400_000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

describe('live page (env-gated)', () => {
  it('serves the real directory without page internals', { skip: !LIVE }, async () => {
    const client = await liveClient();
    const meta = await client.meta();
    assert.ok(meta.services.length >= 1);
    assert.ok(meta.doctors.length >= 1);
    assert.ok(meta.location.id);
    const text = JSON.stringify(meta);
    for (const banned of ['scanToken', 'browserId', 'csrf', 'slotBlocker', 'picktime.com']) {
      assert.equal(text.includes(banned), false);
    }
  });

  it('rejects unknown IDs against the real page', { skip: !LIVE }, async () => {
    const client = await liveClient();
    const { from, to } = nextWeekdayWindow();
    await assert.rejects(() => client.slots({ serviceId: 'no-such-service', from, to }), /404/);
    const meta = await client.meta();
    await assert.rejects(
      () => client.slots({ serviceId: meta.services[0].id, doctorId: 'no-such-doctor', from, to }),
      /404/,
    );
  });

  it('holds, heartbeats, and releases with no residue', { skip: !LIVE }, async () => {
    // Live availability shifts minute to minute, so walk candidates until a
    // hold succeeds; gone slots are the guardrail working, not a failure.
    const client = await liveClient();
    const meta = await client.meta();
    const doctorId = meta.doctors[0].id;
    const serviceId = meta.services[0].id;
    const { from, to } = nextWeekdayWindow();
    const found = await client.slots({ serviceId, doctorId, from, to });
    let roundTrips = 0;
    for (const slot of found.slots.slice(0, 8)) {
      try {
        const hold = await client.hold({ serviceId, doctorId, slotStart: slot.start });
        await client.releaseHold(hold.holdId);
        await assert.rejects(() => client.releaseHold(hold.holdId), /404/);
        roundTrips += 1;
        if (roundTrips === 2) break;
      } catch (err) {
        if (!/42[23]/.test(String(err))) throw err;
      }
    }
    assert.ok(roundTrips === 2, 'expected two hold/release round-trips on live slots');
  });
  it('dry runs save nothing on the live page', { skip: !LIVE }, async () => {
    const client = await liveClient();
    const meta = await client.meta();
    const doctorId = meta.doctors[0].id;
    const serviceId = meta.services[0].id;
    const { from, to } = nextWeekdayWindow();
    const found = await client.slots({ serviceId, doctorId, from, to });
    let proven = false;
    for (const slot of found.slots.slice(0, 8)) {
      try {
        const dry = await client.book({ serviceId, doctorId, slotStart: slot.start, patientName: 'Dry', patientPhone: 'Run', dryRun: true });
        assert.ok('saved' in dry && dry.saved === false);
        proven = true;
        break;
      } catch (err) {
        if (!/42[23]/.test(String(err))) throw err;
      }
    }
    assert.ok(proven, 'expected one live dry run to hold and release');
  });
});
