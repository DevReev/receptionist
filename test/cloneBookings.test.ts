import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CloneBookingsClient } from '../src/cloneBookings.ts';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(
  calls: { url: string; method: string; body: string }[],
  doctors = [{ id: 'ros-1', doctor_name: 'Bob Gowda' }],
): typeof fetch {
  return (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ?? '' });
    const u = String(url);
    if (u.endsWith('/locations')) {
      return jsonResponse({ data: [{ id: 'loc-1', name: 'Bobby Clinic' }] });
    }
    if (u.includes('/locations/loc-1/doctors')) {
      return jsonResponse({ data: doctors });
    }
    if (u.includes('/locations/loc-1/procedures')) {
      return jsonResponse({ data: [{ id: 'proc-1', name: 'Appointment' }] });
    }
    if (u.includes('/availability')) {
      return jsonResponse({
        data: {
          timezone: 'Asia/Kolkata',
          date: '2026-09-14',
          closed: false,
          slots: [{ start_utc: '2026-09-14T03:30:00.000Z', local_int: '202609140900', timezone: 'Asia/Kolkata' }],
          ranges: [],
        },
      });
    }
    if (u.endsWith('/holds')) {
      return jsonResponse({ data: { key: 'HLD-test', state: 'active' } }, 201);
    }
    if (u.endsWith('/bookings')) {
      return jsonResponse({ data: { ref: 'BK-test', status: 'confirmed' } }, 201);
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

const SLOT = {
  service: 'Appointment',
  location: 'Bobby Clinic',
  date: '2026-09-14',
  time: '9:00',
  callerName: 'Asha',
  callerPhone: '9840950950',
};

describe('CloneBookingsClient', () => {
  it('resolves names to clone ids and confirms with an idempotency key', async () => {
    const calls: { url: string; method: string; body: string }[] = [];
    const client = new CloneBookingsClient({ clone: { baseUrl: 'http://clone' }, fetchFn: stubFetch(calls) });
    const outcome = await client.book(SLOT, { idempotencyKey: 'CA1:clone:2026-09-14T09:00' });
    assert.deepEqual(outcome, { ok: true });
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/bookings'));
    assert.ok(post);
    assert.deepEqual(JSON.parse(post.body), {
      hold_key: 'HLD-test',
      patient_name: 'Asha',
      patient_phone: '+919840950950',
    });
  });

  it('refuses a time outside clone availability without writing', async () => {
    const calls: { url: string; method: string; body: string }[] = [];
    const client = new CloneBookingsClient({ clone: { baseUrl: 'http://clone' }, fetchFn: stubFetch(calls) });
    const outcome = await client.book({ ...SLOT, time: '10:30' }, { idempotencyKey: 'k' });
    assert.equal(outcome.ok, false);
    assert.match((outcome as { reason: string }).reason, /not in live availability/);
    assert.equal(calls.some((c) => c.method === 'POST'), false);
  });

  it('names the locations when the caller picked an unknown one', async () => {
    const calls: { url: string; method: string; body: string }[] = [];
    const client = new CloneBookingsClient({ clone: { baseUrl: 'http://clone' }, fetchFn: stubFetch(calls) });
    const outcome = await client.book({ ...SLOT, location: 'Downtown' }, { idempotencyKey: 'k' });
    assert.equal(outcome.ok, false);
    assert.match((outcome as { reason: string }).reason, /Bobby Clinic/);
  });

  it('never auto-selects a doctor: several roster rows ask the caller', async () => {
    const calls: { url: string; method: string; body: string }[] = [];
    const client = new CloneBookingsClient({
      clone: { baseUrl: 'http://clone' },
      fetchFn: stubFetch(calls, [
        { id: 'ros-1', doctor_name: 'Bob Gowda' },
        { id: 'ros-2', doctor_name: 'Alice Rao' },
      ]),
    });
    const outcome = await client.book(SLOT, { idempotencyKey: 'k' });
    assert.equal(outcome.ok, false);
    assert.match((outcome as { reason: string }).reason, /which doctor/);
    assert.equal(calls.some((c) => c.method === 'POST'), false);
  });
});
