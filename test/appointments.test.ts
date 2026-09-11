import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AppointmentsClient, toE164 } from '../src/appointments.ts';

const META = {
  timeZone: 'Asia/Kolkata',
  fetchedAt: '2026-09-11T15:36:08.185Z',
  locations: [
    { id: 'loc-clinic', name: 'Bobby Clinic, Bobby Clinic, Bangalore' },
    { id: 'loc-hospital', name: 'Bobby Hospital, Bobby Hospital, Bangalore' },
  ],
  services: [{ id: 'svc-appt', name: 'Appointment', durationMin: 15, cost: 700 }],
  doctors: [{ id: 'doc-bob', name: 'Bob Gowda' }],
};

const SLOTS = {
  timeZone: 'Asia/Kolkata',
  fetchedAt: '2026-09-11T15:36:08.185Z',
  slots: [
    { serviceId: 'svc-appt', doctorId: 'doc-bob', locationId: 'loc-clinic', start: '2026-09-14T09:00:00' },
    { serviceId: 'svc-appt', doctorId: 'doc-bob', locationId: 'loc-hospital', start: '2026-09-14T09:00:00' },
    { serviceId: 'svc-appt', doctorId: 'doc-bob', locationId: 'loc-clinic', start: '2026-09-14T09:15:00' },
  ],
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(routes: {
  calls: Call[];
  meta?: () => Response;
  slots?: () => Response;
  book?: () => Response;
}): typeof fetch {
  return (async (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => {
    routes.calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body ?? '',
    });
    if (String(url).includes('/v1/meta')) return (routes.meta ?? (() => jsonResponse(META)))();
    if (String(url).includes('/v1/get_available_slots')) {
      return (routes.slots ?? (() => jsonResponse(SLOTS)))();
    }
    if (String(url).includes('/v1/book_appointment')) {
      return (routes.book ?? (() => jsonResponse({ bookingId: 'b1' }, 201)))();
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

function client(fetchFn: typeof fetch, windowDays = 14): AppointmentsClient {
  return new AppointmentsClient({
    appointments: { baseUrl: 'http://stub-api', windowDays },
    fetchFn,
  });
}

describe('AppointmentsClient availability', () => {
  it('groups live slots by location with dates and times and caches the read', async () => {
    const calls: Call[] = [];
    const appointments = client(stubFetch({ calls }));
    const block = await appointments.availabilityBlock();
    assert.match(block, /Bobby Clinic · Appointment · 2026-09-14: 09:00 09:15/);
    assert.match(block, /Bobby Hospital · Appointment · 2026-09-14: 09:00/);
    assert.match(block, /timezone Asia\/Kolkata/);
    const slotCalls = calls.filter((c) => c.url.includes('/v1/get_available_slots'));
    assert.equal(slotCalls.length, 1);
    assert.match(slotCalls[0]!.url, /serviceId=svc-appt/);
    assert.match(slotCalls[0]!.url, /from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
    await appointments.availabilityBlock();
    assert.equal(calls.filter((c) => c.url.includes('/v1/get_available_slots')).length, 1);
  });

  it('says none available instead of listing nothing', async () => {
    const appointments = client(
      stubFetch({ calls: [], slots: () => jsonResponse({ ...SLOTS, slots: [], reason: 'none-available' }) }),
    );
    const block = await appointments.availabilityBlock();
    assert.match(block, /none: no Slots are open/);
  });

  it('retries transient page-downs before failing', async () => {
    let attempts = 0;
    const appointments = client(
      stubFetch({
        calls: [],
        slots: () => {
          attempts += 1;
          return attempts === 1 ? jsonResponse({ error: 'page-down' }, 502) : jsonResponse(SLOTS);
        },
      }),
    );
    const block = await appointments.availabilityBlock();
    assert.match(block, /09:00/);
    assert.equal(attempts, 2);
  });

  it('logs every booking-API attempt with status, error code, and timing', async () => {
    const events: Record<string, unknown>[] = [];
    let attempts = 0;
    const appointments = new AppointmentsClient({
      appointments: { baseUrl: 'http://stub-api', windowDays: 14 },
      fetchFn: stubFetch({
        calls: [],
        slots: () => {
          attempts += 1;
          return attempts === 1 ? jsonResponse({ error: 'page-down' }, 502) : jsonResponse(SLOTS);
        },
      }),
      onEvent: (e) => events.push(e),
    });
    await appointments.availabilityBlock();
    const http = events.filter(
      (e) => e.event === 'http' && String(e.path).includes('get_available_slots'),
    );
    assert.equal(http.length, 2);
    assert.equal(http[0]!.status, 502);
    assert.equal(http[0]!.error, 'page-down');
    assert.equal(typeof http[0]!.ms, 'number');
    assert.equal(http[1]!.status, 200);
    assert.ok(events.some((e) => e.event === 'result' && e.resource === 'slots' && e.count === 3));
  });
});

describe('AppointmentsClient booking', () => {
  const slot = {
    service: 'Appointment',
    location: 'Bobby Clinic',
    date: '2026-09-14',
    time: '9:00',
    callerName: 'Asha',
    callerPhone: '9840950950',
  };

  it('resolves names to live IDs and confirms with an idempotency key', async () => {
    const calls: Call[] = [];
    const appointments = client(stubFetch({ calls }));
    const outcome = await appointments.book(slot, { idempotencyKey: 'CA1:loc:2026-09-14T09:00' });
    assert.deepEqual(outcome, { ok: true });
    const post = calls.find((c) => c.method === 'POST');
    assert.ok(post);
    assert.equal(post.url, 'http://stub-api/v1/book_appointment');
    assert.equal(post.headers['Idempotency-Key'], 'CA1:loc:2026-09-14T09:00');
    assert.deepEqual(JSON.parse(post.body), {
      serviceId: 'svc-appt',
      doctorId: 'doc-bob',
      locationId: 'loc-clinic',
      slotStart: '2026-09-14T09:00:00',
      patientName: 'Asha',
      patientPhone: '+919840950950',
    });
  });

  it('refuses a slot that is not in live availability without writing', async () => {
    const calls: Call[] = [];
    const appointments = client(stubFetch({ calls }));
    const outcome = await appointments.book({ ...slot, time: '09:30' }, { idempotencyKey: 'k' });
    assert.equal(outcome.ok, false);
    assert.match((outcome as { reason: string }).reason, /not in live availability/);
    assert.equal(calls.some((c) => c.method === 'POST'), false);
  });

  it('names the locations when the caller picked an unknown one', async () => {
    const appointments = client(stubFetch({ calls: [] }));
    const outcome = await appointments.book({ ...slot, location: 'Downtown' }, { idempotencyKey: 'k' });
    assert.equal(outcome.ok, false);
    assert.match((outcome as { reason: string }).reason, /Bobby Clinic or Bobby Hospital/);
  });

  it('turns slot-taken into a speakable retry reason', async () => {
    const appointments = client(
      stubFetch({
        calls: [],
        book: () => jsonResponse({ error: 'slot-taken', message: 'taken' }, 422),
      }),
    );
    const outcome = await appointments.book(slot, { idempotencyKey: 'k' });
    assert.equal(outcome.ok, false);
    assert.match((outcome as { reason: string }).reason, /just taken/);
  });

  it('turns page-down into a clinic-will-confirm reason', async () => {
    const appointments = client(
      stubFetch({ calls: [], book: () => jsonResponse({ error: 'page-down' }, 502) }),
    );
    const outcome = await appointments.book(slot, { idempotencyKey: 'k' });
    assert.equal(outcome.ok, false);
    assert.match((outcome as { reason: string }).reason, /clinic will confirm/);
  });
});

describe('toE164', () => {
  it('normalizes Indian mobile forms', () => {
    assert.equal(toE164('9840950950'), '+919840950950');
    assert.equal(toE164('098409 50950'), '+919840950950');
    assert.equal(toE164('+91 98409-50950'), '+919840950950');
    assert.equal(toE164('919840950950'), '+919840950950');
  });
});
