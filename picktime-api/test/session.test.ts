import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.ts';
import type { DriverSession, PicktimeDriver } from '../src/driver.ts';
import { MemoryDriver } from '../src/memoryDriver.ts';
import { Pool } from '../src/pool.ts';

/** Counts page sessions and directory loads so a route can never quietly fan out again. */
class CountingDriver implements PicktimeDriver {
  sessions = 0;
  directoryLoads = 0;
  private readonly inner = new MemoryDriver();

  checkHealth(): Promise<void> {
    return this.inner.checkHealth();
  }

  withSession<T>(fn: (session: DriverSession) => Promise<T>): Promise<T> {
    this.sessions += 1;
    return this.inner.withSession((inner) => {
      // Same lazy cache as the Playwright session: repeated reads hit the page once.
      let cached: ReturnType<MemoryDriver['getDirectory']> | null = null;
      return fn({
        getDirectory: async () => {
          if (!cached) {
            this.directoryLoads += 1;
            cached = inner.getDirectory();
          }
          return cached;
        },
        listSlots: (args) => inner.listSlots(args),
        holdSlot: (args) => inner.holdSlot(args),
        heartbeat: (id) => inner.heartbeat(id),
        releaseHold: (id) => inner.releaseHold(id),
        confirmBooking: (args) => inner.confirmBooking(args),
      });
    });
  }
}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function start(driver: CountingDriver) {
  const api = createApp({
    checkReadiness: async () => {},
    logEvent: () => {},
    pageId: 'page-1',
    timeZone: 'Asia/Kolkata',
    driver,
    pool: new Pool(4),
  }).listen(0);
  servers.push(api);
  const addr = api.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

function futureWeekdayWindow(daysFromNow = 30): { from: string; to: string } {
  const from = new Date(Date.now() + daysFromNow * 86_400_000);
  while (from.getUTCDay() === 0 || from.getUTCDay() === 6) from.setUTCDate(from.getUTCDate() + 1);
  const to = new Date(from.getTime() + 2 * 86_400_000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

describe('one driver session per public request', () => {
  it('resolves doctor and locations and lists slots inside a single session', async () => {
    const driver = new CountingDriver();
    const base = await start(driver);
    const { from, to } = futureWeekdayWindow();
    const res = await fetch(`${base}/v1/get_available_slots?serviceId=svc-sample&from=${from}&to=${to}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { slots: unknown[] };
    assert.ok(body.slots.length > 0);
    assert.equal(driver.sessions, 1);
    assert.equal(driver.directoryLoads, 1);
  });

  it('serves the directory from one session', async () => {
    const driver = new CountingDriver();
    const base = await start(driver);
    const res = await fetch(`${base}/v1/meta`);
    assert.equal(res.status, 200);
    assert.equal(driver.sessions, 1);
    assert.equal(driver.directoryLoads, 1);
  });
});
