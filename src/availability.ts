// Per-Location availability fan-out for ticket 01 (spec §10).
//
// `get_availability` used to read Picktime-only via
// `AppointmentsClient.availabilityBlock()`. After the flip it routes per
// Location like `proposeBooking` does: guide Locations on `clone` read the
// clone's `GET /availability` (one day per query, `local_int + timezone`
// Slots, slot-ranges upstream per `booking/api/routes/availability.ts`);
// Picktime Locations keep the current Picktime block.
//
// Fail-closed: a guide read error (or no `## Locations` toggles) returns the
// Picktime-only block, mirroring `resolveBookingTarget`'s picktime default.

import type { AppointmentsClient } from './appointments.ts';
import type { CloneBookingsClient } from './cloneBookings.ts';
import { parseLocationRouting, routeForLocation } from './routing.ts';
import { parseAvailabilityBlock, type SlotOption } from './dialogue.ts';

export const FANOUT_TIMEZONE_DEFAULT = 'Asia/Kolkata';
export const FANOUT_WINDOW_WORKING_DAYS_DEFAULT = 5;

function shortName(name: string): string {
  return name.split(',')[0]!.trim();
}

function nameMatches(apiName: string, given: string): boolean {
  const a = apiName.trim().toLowerCase();
  const b = given.trim().toLowerCase();
  return a === b || shortName(a) === b || a === shortName(b);
}

function isoDateInTimeZone(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function addDays(dateOnly: string, days: number): string {
  const [year, month, day] = dateOnly.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day! + days));
  return date.toISOString().slice(0, 10);
}

function isWeekend(dateOnly: string): boolean {
  const [year, month, day] = dateOnly.split('-').map(Number);
  const weekday = new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

function addWorkingDays(from: string, days: number): string {
  let date = from;
  let counted = 0;
  while (counted < days) {
    if (!isWeekend(date)) counted += 1;
    if (counted < days) date = addDays(date, 1);
  }
  return date;
}

/**
 * Calendar dates to query on the clone: every day in the Picktime-style
 * working-day window (weekends included in the range; closed days return no
 * Slots). Mirrors `AppointmentsClient`'s `from`/`to` computation.
 */
export function workingDates(now: Date, timeZone: string, windowWorkingDays: number): string[] {
  const from = isoDateInTimeZone(now, timeZone);
  const to = addWorkingDays(from, windowWorkingDays);
  const out: string[] = [];
  let date = from;
  for (;;) {
    out.push(date);
    if (date === to) break;
    date = addDays(date, 1);
  }
  return out;
}

/** `YYYYMMDDHHMM` local int → `{ date: YYYY-MM-DD, time: HH:MM }`, null when malformed. */
export function localIntToDateTime(localInt: string): { date: string; time: string } | null {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(localInt.trim());
  if (!match) return null;
  return { date: `${match[1]}-${match[2]}-${match[3]}`, time: `${match[4]}:${match[5]}` };
}

/** Keep only Picktime-routed Slots; clone-routed Locations must not speak Picktime times. */
export function filterPicktimeSlots(slots: SlotOption[], guideRaw: string): SlotOption[] {
  return slots.filter((s) => routeForLocation(guideRaw, s.location) === 'picktime');
}

/** Grouped block in the Picktime shape dialogue already parses. */
export function formatMergedBlock(
  slots: SlotOption[],
  opts: { timezone: string; fetchedAt: string; windowWorkingDays: number },
): string {
  const header = `AVAILABILITY (fetched ${opts.fetchedAt}, timezone ${opts.timezone} — only these slots exist)`;
  if (slots.length === 0) {
    return `${header}\n- none: no Slots are open in the next ${opts.windowWorkingDays} working days. Do not offer any times.`;
  }
  const groups = new Map<string, { location: string; service: string; date: string; times: string[] }>();
  for (const slot of slots) {
    const key = `${slot.location} · ${slot.service} · ${slot.date}`;
    const entry = groups.get(key) ?? { location: slot.location, service: slot.service, date: slot.date, times: [] };
    entry.times.push(slot.time);
    groups.set(key, entry);
  }
  const lines = [...groups.values()]
    .sort((a, b) => {
      const ka = `${a.location} · ${a.service} · ${a.date}`;
      const kb = `${b.location} · ${b.service} · ${b.date}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    })
    .map((g) => `- ${g.location} · ${g.service} · ${g.date}: ${[...new Set(g.times)].sort().join(' ')}`);
  return [header, '- location · service · date: times (24-hour HH:MM)', ...lines].join('\n');
}

export interface AvailabilityReaderOpts {
  appointments: AppointmentsClient;
  clone: CloneBookingsClient;
  /** Guide text per call; rejects on read error so the reader can fail closed. */
  loadGuideRaw: () => Promise<string>;
  windowWorkingDays?: number;
  now?: () => Date;
  timezone?: string;
  onEvent?: (event: Record<string, unknown>) => void;
}

/**
 * Fan-out reader for `get_availability`: per-Location routing via the guide,
 * Picktime lines filtered to Picktime Locations, clone lines read day-by-day
 * from `GET /availability`. Drop-in for `() => appointments.availabilityBlock()`.
 */
export function createAvailabilityReader(opts: AvailabilityReaderOpts): () => Promise<string> {
  const windowWorkingDays = opts.windowWorkingDays ?? FANOUT_WINDOW_WORKING_DAYS_DEFAULT;
  const now = opts.now ?? (() => new Date());
  const timezone = opts.timezone ?? FANOUT_TIMEZONE_DEFAULT;
  const log = (event: Record<string, unknown>): void => {
    opts.onEvent?.({ kind: 'availability-fanout', ...event });
  };

  return async (): Promise<string> => {
    let guideRaw: string;
    try {
      guideRaw = await opts.loadGuideRaw();
    } catch (err) {
      log({ event: 'guide-error', detail: err instanceof Error ? err.message : String(err) });
      return opts.appointments.availabilityBlock();
    }
    const table = parseLocationRouting(guideRaw);
    if (table.size === 0) return opts.appointments.availabilityBlock();
    const cloneGuideNames = [...table.entries()].filter(([, target]) => target === 'clone').map(([name]) => name);
    if (cloneGuideNames.length === 0) {
      // Picktime-only regression: no clone read, byte-identical Picktime block.
      return opts.appointments.availabilityBlock();
    }
    const allClone = cloneGuideNames.length === table.size;

    let picktimeSlots: SlotOption[] = [];
    let picktimeError: unknown = null;
    if (!allClone) {
      try {
        const block = await opts.appointments.availabilityBlock();
        picktimeSlots = filterPicktimeSlots(parseAvailabilityBlock(block), guideRaw);
      } catch (err) {
        picktimeError = err;
        log({ event: 'picktime-error', detail: err instanceof Error ? err.message : String(err) });
      }
    }

    let cloneSlots: SlotOption[] = [];
    try {
      cloneSlots = await readCloneSlots(opts.clone, cloneGuideNames, {
        dates: workingDates(now(), timezone, windowWorkingDays),
      });
    } catch (err) {
      log({ event: 'clone-error', detail: err instanceof Error ? err.message : String(err) });
      if (picktimeSlots.length === 0 && allClone) throw err;
      // Mixed routing with a sick clone still speaks its Picktime Locations.
      if (picktimeSlots.length === 0 && picktimeError !== null) throw err;
    }

    if (!allClone && picktimeError !== null && picktimeSlots.length === 0 && cloneSlots.length === 0) {
      throw picktimeError;
    }
    const merged = dedupeSlots([...picktimeSlots, ...cloneSlots]);
    return formatMergedBlock(merged, {
      timezone,
      fetchedAt: new Date().toISOString(),
      windowWorkingDays,
    });
  };
}

async function readCloneSlots(
  clone: CloneBookingsClient,
  cloneGuideNames: string[],
  opts: { dates: string[] },
): Promise<SlotOption[]> {
  const locations = await clone.listLocations();
  const matched: { guideName: string; locationId: string }[] = [];
  for (const guideName of cloneGuideNames) {
    const found = locations.find((l) => nameMatches(String(l.name ?? ''), guideName));
    if (found) matched.push({ guideName, locationId: found.id });
  }
  const out: SlotOption[] = [];
  await Promise.all(
    matched.map(async ({ guideName, locationId }) => {
      const [doctors, procedures] = await Promise.all([
        clone.listDoctors(locationId),
        clone.listProcedures(locationId),
      ]);
      if (doctors.length === 0 || procedures.length === 0) return;
      // Union across roster rows: a multi-doctor Location still offers its
      // times; the booking write asks the caller to choose (no auto-select).
      const reads: Promise<void>[] = [];
      for (const doctor of doctors) {
        for (const procedure of procedures) {
          const service = String(procedure.name ?? '').trim();
          if (!service) continue;
          for (const date of opts.dates) {
            reads.push(
              clone.fetchDaySlots(locationId, doctor.id, procedure.id, date).then((daySlots) => {
                for (const s of daySlots) {
                  const parsed = localIntToDateTime(s.local_int);
                  if (!parsed) continue;
                  out.push({ service, location: guideName, date: parsed.date, time: parsed.time });
                }
              }),
            );
          }
        }
      }
      await Promise.all(reads);
    }),
  );
  return out;
}

function dedupeSlots(slots: SlotOption[]): SlotOption[] {
  const seen = new Set<string>();
  const out: SlotOption[] = [];
  for (const s of slots) {
    const key = `${s.location} · ${s.service} · ${s.date}T${s.time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  out.sort((a, b) => {
    const ka = `${a.location} · ${a.service} · ${a.date}T${a.time}`;
    const kb = `${b.location} · ${b.service} · ${b.date}T${b.time}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return out;
}
