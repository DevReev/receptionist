import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PlaywrightDriver } from '../src/playwrightDriver.ts';

/**
 * Local fake Picktime page: exercises the real Playwright driver (navigation,
 * bootstrap extraction, XHR surface) without the live site. Regression seam
 * for the session/parallelism/retry behavior that the live page made flaky.
 */
interface FakeState {
  pageLoads: number;
  directoryLoads: number;
  slotRequests: number;
  slotInFlight: number;
  maxSlotInFlight: number;
  slotAttempts: Map<string, number>;
  slotDelayMs: number;
  slotSlowOnceMs: number;
  directoryFailuresLeft: number;
  holdRequests: number;
  holdDelayMs: number;
}

function freshState(): FakeState {
  return {
    pageLoads: 0,
    directoryLoads: 0,
    slotRequests: 0,
    slotInFlight: 0,
    maxSlotInFlight: 0,
    slotAttempts: new Map(),
    slotDelayMs: 0,
    slotSlowOnceMs: 0,
    directoryFailuresLeft: 0,
    holdRequests: 0,
    holdDelayMs: 0,
  };
}

const DIRECTORY = {
  status: true,
  data: {
    services: [{ id: 'svc-1', name: 'Appointment', duration: 15, cost: 700, status: true }],
    team: [{ id: 'doc-1', fname: 'Bob', lname: 'Gowda' }],
    locations: [
      { id: 'loc-1', name: 'Bobby Clinic', address: 'x', city: 'Bangalore' },
      { id: 'loc-2', name: 'Bobby Hospital', address: 'y', city: 'Bangalore' },
    ],
    bookingPreferences: { booking_slot: 15, contact_form_req_fields: ['firstName'] },
    account: { id: 'acct-1' },
    accountTimezoneID: 'Asia/Kolkata',
  },
};

const SERVERS: Server[] = [];
const DRIVERS: PlaywrightDriver[] = [];

afterEach(async () => {
  for (const server of SERVERS.splice(0)) server.close();
  for (const driver of DRIVERS.splice(0)) await driver.close();
});

async function startFakePage(state: FakeState): Promise<string> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const json = (payload: unknown, status = 200): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (path === '/page-test') {
      state.pageLoads += 1;
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'pt_csrf=csrf-token; Path=/' });
      res.end('<html><script>const scanToken=`scan-token`; const browserId=`browser-id`;</script></html>');
      return;
    }
    if (path === '/endpoint/1.0.0/ia/loadBookingPage') {
      state.directoryLoads += 1;
      if (state.directoryFailuresLeft > 0) {
        state.directoryFailuresLeft -= 1;
        json({ error: 'upstream' }, 500);
        return;
      }
      json(DIRECTORY);
      return;
    }
    if (path === '/endpoint/1.0.0/ia/bookingFlowData') {
      json({ status: true, data: {} });
      return;
    }
    if (path === '/endpoint/1.0.0/ia/slots') {
      state.slotRequests += 1;
      state.slotInFlight += 1;
      state.maxSlotInFlight = Math.max(state.maxSlotInFlight, state.slotInFlight);
      const day = (url.searchParams.get('dateAndTime') ?? '').slice(0, 8);
      const attempt = (state.slotAttempts.get(day) ?? 0) + 1;
      state.slotAttempts.set(day, attempt);
      const delay = state.slotSlowOnceMs > 0 && attempt === 1 ? state.slotSlowOnceMs : state.slotDelayMs;
      try {
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        json({ status: true, data: [`${day}0900`, `${day}0915`] });
      } finally {
        state.slotInFlight -= 1;
      }
      return;
    }
    if (path === '/endpoint/1.0.0/ia/holdSlot') {
      state.holdRequests += 1;
      if (state.holdDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.holdDelayMs));
      json({ status: true, data: { blockerKey: 'hold-1', expiresAt: '20260930100000' } });
      return;
    }
    json({ error: 'not-found' }, 404);
  });
  SERVERS.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function driverFor(state: FakeState, actionTimeoutMs = 5_000): Promise<PlaywrightDriver> {
  const baseUrl = await startFakePage(state);
  const driver = new PlaywrightDriver({
    pageId: 'page-test',
    baseUrl,
    navigationTimeoutMs: 5_000,
    actionTimeoutMs,
    dayConcurrency: 4,
  });
  DRIVERS.push(driver);
  return driver;
}

describe('PlaywrightDriver sessions (local fake page)', () => {
  it('navigates once and loads the directory once per session', async () => {
    const state = freshState();
    const driver = await driverFor(state);
    const out = await driver.withSession(async (session) => {
      const directory = await session.getDirectory();
      const slots = await session.listSlots({
        serviceId: 'svc-1',
        doctorId: 'doc-1',
        locationId: 'loc-1',
        from: '2026-10-05',
        to: '2026-10-08',
      });
      return { directory, slots };
    });
    assert.equal(state.pageLoads, 1);
    assert.equal(state.directoryLoads, 1);
    assert.equal(state.slotRequests, 4);
    assert.equal(out.directory.locations.length, 2);
    assert.equal(out.slots.slots.length, 8);
  });

  it('fetches days in parallel within one session', async () => {
    const state = freshState();
    state.slotDelayMs = 200;
    const driver = await driverFor(state);
    await driver.withSession((session) =>
      session.listSlots({
        serviceId: 'svc-1',
        doctorId: 'doc-1',
        locationId: 'loc-1',
        from: '2026-10-05',
        to: '2026-10-12',
      }),
    );
    assert.equal(state.slotRequests, 8);
    assert.ok(state.maxSlotInFlight >= 2, `expected parallel fetches, max was ${state.maxSlotInFlight}`);
  });

  it('retries a timed-out day read once', async () => {
    const state = freshState();
    state.slotSlowOnceMs = 400;
    const driver = await driverFor(state, 200);
    const result = await driver.withSession((session) =>
      session.listSlots({
        serviceId: 'svc-1',
        doctorId: 'doc-1',
        locationId: 'loc-1',
        from: '2026-10-05',
        to: '2026-10-06',
      }),
    );
    assert.equal(result.slots.length, 4);
    assert.equal(state.slotRequests, 4, 'two days, each retried once after the slow first attempt');
  });

  it('retries the whole session once on a transient read failure', async () => {
    const state = freshState();
    state.directoryFailuresLeft = 1;
    const driver = await driverFor(state);
    const directory = await driver.withSession((session) => session.getDirectory());
    assert.equal(directory.services.length, 1);
    assert.equal(state.pageLoads, 2);
    assert.equal(state.directoryLoads, 2);
  });

  it('never retries a session once a write has started', async () => {
    const state = freshState();
    state.holdDelayMs = 1_000;
    const driver = await driverFor(state, 200);
    await assert.rejects(
      () =>
        driver.withSession((session) =>
          session.holdSlot({
            serviceId: 'svc-1',
            doctorId: 'doc-1',
            locationId: 'loc-1',
            slotStart: '2026-10-05T09:00:00',
          }),
        ),
      /booking page unavailable/,
    );
    assert.equal(state.pageLoads, 1, 'a write attempt must not re-navigate and replay');
    assert.equal(state.holdRequests, 1);
  });
});
