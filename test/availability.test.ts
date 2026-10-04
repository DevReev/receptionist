import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AppointmentsClient } from '../src/appointments.ts';
import { CloneBookingsClient } from '../src/cloneBookings.ts';
import {
  createAvailabilityReader,
  filterPicktimeSlots,
  formatMergedBlock,
  localIntToDateTime,
  workingDates,
} from '../src/availability.ts';
import { parseAvailabilityBlock } from '../src/dialogue.ts';

const GUIDE_MIXED = [
  '# Clinic Guide — Bobby Clinic',
  '',
  '## Locations',
  '',
  '- **Bobby Clinic** — Picktime label: `Bobby Clinic, Bobby Clinic, Bangalore` — books on: clone.',
  '- **Bobby Hospital** — Picktime label: `Bobby Hospital, Bobby Hospital, Bangalore` — books on: picktime.',
  '',
].join('\n');

const GUIDE_BOTH_CLONE = [
  '# Clinic Guide — Bobby Clinic',
  '',
  '## Locations',
  '',
  '- **Bobby Clinic** — Picktime label: `Bobby Clinic, Bobby Clinic, Bangalore` — books on: clone.',
  '- **Bobby Hospital** — Picktime label: `Bobby Hospital, Bobby Hospital, Bangalore` — books on: clone.',
  '',
].join('\n');

const GUIDE_PICKTIME_ONLY = [
  '# Clinic Guide — Bobby Clinic',
  '',
  '## Locations',
  '',
  '- **Bobby Clinic** — Picktime label: `Bobby Clinic, Bobby Clinic, Bangalore` — books on: picktime.',
  '- **Bobby Hospital** — Picktime label: `Bobby Hospital, Bobby Hospital, Bangalore` — books on: picktime.',
  '',
].join('\n');

const PICKTIME_META = {
  timeZone: 'Asia/Kolkata',
  fetchedAt: '2026-09-14T00:00:00.000Z',
  locations: [
    { id: 'loc-clinic', name: 'Bobby Clinic, Bobby Clinic, Bangalore' },
    { id: 'loc-hospital', name: 'Bobby Hospital, Bobby Hospital, Bangalore' },
  ],
  services: [{ id: 'svc-appt', name: 'Appointment' }],
  doctors: [{ id: 'doc-bob', name: 'Bob Gowda' }],
};

// Picktime times are deliberately distinct from clone times: Clinic 09:00,
// Hospital 10:00 on the single test date.
const PICKTIME_SLOTS = {
  timeZone: 'Asia/Kolkata',
  fetchedAt: '2026-09-14T00:00:00.000Z',
  slots: [
    { serviceId: 'svc-appt', doctorId: 'doc-bob', locationId: 'loc-clinic', start: '2026-09-14T09:00:00' },
    { serviceId: 'svc-appt', doctorId: 'doc-bob', locationId: 'loc-hospital', start: '2026-09-14T10:00:00' },
  ],
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function picktimeFetch(calls: string[]): typeof fetch {
  return (async (url: string) => {
    calls.push(String(url));
    const u = String(url);
    if (u.includes('/v1/meta')) return jsonResponse(PICKTIME_META);
    if (u.includes('/v1/get_available_slots')) return jsonResponse(PICKTIME_SLOTS);
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

// Clone times are distinct: Clinic 11:00, Hospital 12:00. Date-aware so the
// single-day window (2026-09-14) is the only day with Slots.
function cloneFetch(calls: string[]): typeof fetch {
  return (async (url: string) => {
    calls.push(String(url));
    const u = String(url);
    if (u.endsWith('/locations')) {
      return jsonResponse({ data: [{ id: 'loc-1', name: 'Bobby Clinic' }, { id: 'loc-2', name: 'Bobby Hospital' }] });
    }
    if (u.includes('/locations/loc-1/doctors')) {
      return jsonResponse({ data: [{ id: 'ros-1', doctor_name: 'Bob Gowda' }] });
    }
    if (u.includes('/locations/loc-2/doctors')) {
      return jsonResponse({ data: [{ id: 'ros-2', doctor_name: 'Bob Gowda' }] });
    }
    if (u.includes('/locations/loc-1/procedures')) {
      return jsonResponse({ data: [{ id: 'proc-1', name: 'Appointment' }] });
    }
    if (u.includes('/locations/loc-2/procedures')) {
      return jsonResponse({ data: [{ id: 'proc-2', name: 'Appointment' }] });
    }
    if (u.includes('/availability')) {
      const parsed = new URL(u);
      const date = parsed.searchParams.get('date') ?? '2026-09-14';
      const locationId = parsed.searchParams.get('location_id');
      const compact = date.replaceAll('-', '');
      const time = locationId === 'loc-1' ? '1100' : '1200';
      return jsonResponse({
        data: {
          timezone: 'Asia/Kolkata',
          date,
          closed: false,
          slots: [{ start_utc: `${date}T05:30:00.000Z`, local_int: `${compact}${time}`, timezone: 'Asia/Kolkata' }],
          ranges: [],
        },
      });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

function reader(opts: {
  guideRaw: string;
  picktimeCalls: string[];
  cloneCalls: string[];
  loadGuide?: () => Promise<string>;
}) {
  const appointments = new AppointmentsClient({
    appointments: { baseUrl: 'http://picktime', windowWorkingDays: 1 },
    fetchFn: picktimeFetch(opts.picktimeCalls),
    now: () => new Date('2026-09-14T04:00:00Z'),
  });
  const clone = new CloneBookingsClient({
    clone: { baseUrl: 'http://clone' },
    fetchFn: cloneFetch(opts.cloneCalls),
  });
  return createAvailabilityReader({
    appointments,
    clone,
    loadGuideRaw: opts.loadGuide ?? (() => Promise.resolve(opts.guideRaw)),
    windowWorkingDays: 1,
    now: () => new Date('2026-09-14T04:00:00Z'),
    timezone: 'Asia/Kolkata',
  });
}

describe('availability fan-out helpers', () => {
  it('parses local_int YYYYMMDDHHMM into date and time', () => {
    assert.deepEqual(localIntToDateTime('202609141100'), { date: '2026-09-14', time: '11:00' });
    assert.equal(localIntToDateTime('bogus'), null);
  });

  it('builds a single-day window for window=1 on a working day', () => {
    assert.deepEqual(
      workingDates(new Date('2026-09-14T04:00:00Z'), 'Asia/Kolkata', 1),
      ['2026-09-14'],
    );
  });

  it('filters Picktime Slots to Picktime-routed Locations only', () => {
    const slots = [
      { service: 'Appointment', location: 'Bobby Clinic', date: '2026-09-14', time: '09:00' },
      { service: 'Appointment', location: 'Bobby Hospital', date: '2026-09-14', time: '10:00' },
    ];
    const kept = filterPicktimeSlots(slots, GUIDE_MIXED);
    assert.deepEqual(kept.map((s) => s.location), ['Bobby Hospital']);
  });

  it('formats a merged block the dialogue parser round-trips', () => {
    const block = formatMergedBlock(
      [
        { service: 'Appointment', location: 'Bobby Clinic', date: '2026-09-14', time: '11:00' },
        { service: 'Appointment', location: 'Bobby Hospital', date: '2026-09-14', time: '10:00' },
      ],
      { timezone: 'Asia/Kolkata', fetchedAt: '2026-09-14T00:00:00.000Z', windowWorkingDays: 1 },
    );
    const slots = parseAvailabilityBlock(block);
    assert.equal(slots.length, 2);
  });
});

describe('availability fan-out per Location (ticket 01)', () => {
  it('mixed routing offers clone times for the flipped Location and Picktime times for the rest', async () => {
    const picktimeCalls: string[] = [];
    const cloneCalls: string[] = [];
    const block = await reader({ guideRaw: GUIDE_MIXED, picktimeCalls, cloneCalls })();
    // Flipped Clinic speaks clone-only: 11:00 present, Picktime 09:00 absent.
    assert.match(block, /Bobby Clinic · Appointment · 2026-09-14: 11:00/);
    assert.doesNotMatch(block, /Bobby Clinic · Appointment · 2026-09-14: 09:00/);
    // Picktime Hospital keeps its Picktime time and never speaks clone times.
    assert.match(block, /Bobby Hospital · Appointment · 2026-09-14: 10:00/);
    assert.doesNotMatch(block, /Bobby Hospital · Appointment · 2026-09-14:.*12:00/);
    assert.ok(picktimeCalls.some((u) => u.includes('/v1/get_available_slots')));
    assert.ok(cloneCalls.some((u) => u.includes('/availability')));
  });

  it('both-flipped speaks clone-only with zero Picktime times and no Picktime read', async () => {
    const picktimeCalls: string[] = [];
    const cloneCalls: string[] = [];
    const block = await reader({ guideRaw: GUIDE_BOTH_CLONE, picktimeCalls, cloneCalls })();
    assert.match(block, /Bobby Clinic · Appointment · 2026-09-14: 11:00/);
    assert.match(block, /Bobby Hospital · Appointment · 2026-09-14: 12:00/);
    assert.doesNotMatch(block, /09:00/);
    assert.doesNotMatch(block, /10:00/);
    assert.equal(picktimeCalls.length, 0);
    assert.ok(cloneCalls.some((u) => u.includes('/availability')));
  });

  it('Picktime-only guides keep the Picktime block without touching the clone', async () => {
    const picktimeCalls: string[] = [];
    const cloneCalls: string[] = [];
    const block = await reader({ guideRaw: GUIDE_PICKTIME_ONLY, picktimeCalls, cloneCalls })();
    assert.match(block, /Bobby Clinic · Appointment · 2026-09-14: 09:00/);
    assert.match(block, /Bobby Hospital · Appointment · 2026-09-14: 10:00/);
    assert.doesNotMatch(block, /11:00/);
    assert.doesNotMatch(block, /12:00/);
    assert.equal(cloneCalls.length, 0);
  });

  it('fails closed to Picktime when the guide cannot be read', async () => {
    const picktimeCalls: string[] = [];
    const cloneCalls: string[] = [];
    const block = await reader({
      guideRaw: GUIDE_MIXED,
      picktimeCalls,
      cloneCalls,
      loadGuide: () => Promise.reject(new Error('guide-missing')),
    })();
    assert.match(block, /Bobby Clinic · Appointment · 2026-09-14: 09:00/);
    assert.match(block, /Bobby Hospital · Appointment · 2026-09-14: 10:00/);
    assert.equal(cloneCalls.length, 0);
  });
});
