// Clone booking path for IMP-10 (spec §6, §10).
//
// When the `clinic.md` toggle routes a Location at the clone, the
// Receptionist books through the clone's own REST API (public-write throttled
// submits, same posture as the IMP-08 widget) instead of the Picktime Tool
// API. Name resolution is by clinic display name (case-insensitive); the
// doctor defaults to the first roster row whose name matches the guide's
// doctor, else the first roster row (v1 single-doctor rule — a multi-doctor
// page asks the caller to choose, same as the Picktime `pick-a-doctor`
// contract). The requested time is re-checked against live clone availability
// before the hold, so a flip still books a real Slot.
//
// Fail-closed: any resolution or availability miss returns a speakable
// `{ ok: false, reason }` and never writes. Throttled clone responses (429)
// surface as "try again in a moment", same dialect as `appointments.ts`.

import type { BookingOutcome, ProposedSlot } from './app.ts';
import { toE164 } from './appointments.ts';

export interface CloneBookingsEnv {
  baseUrl: string;
}

interface NamedRow {
  id: string;
  name?: string;
  doctor_name?: string;
  display_name?: string | null;
}

interface AvailabilitySlot {
  start_utc: string;
  local_int: string;
  timezone: string;
}

function shortName(name: string): string {
  return name.split(',')[0]!.trim();
}

function nameMatches(apiName: string, given: string): boolean {
  const a = apiName.trim().toLowerCase();
  const b = given.trim().toLowerCase();
  return a === b || shortName(a) === b || a === shortName(b);
}

function normalizeTime(raw: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return raw.trim();
  return `${match[1]!.padStart(2, '0')}:${match[2]}`;
}

async function getJson(fetchFn: typeof fetch, url: string): Promise<{ status: number; json: unknown }> {
  const res = await fetchFn(url);
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function envelopeData(json: unknown): unknown {
  if (json && typeof json === 'object' && 'data' in (json as object)) {
    return (json as { data: unknown }).data;
  }
  return json;
}

function failureReason(status: number, json: unknown): string {
  if (status === 429) return 'the booking system is busy; ask the caller to try again in a moment';
  let code = '';
  if (json && typeof json === 'object' && 'error' in (json as object)) {
    const err = (json as { error?: unknown }).error;
    if (err && typeof err === 'object' && 'code' in (err as object)) {
      code = String((err as { code: unknown }).code);
    } else if (typeof err === 'string') {
      code = err;
    }
  }
  switch (code) {
    case 'conflict':
    case 'slot-taken':
      return 'that time was just taken; offer another time from the availability block';
    case 'hold_expired':
      return 'that hold lapsed; take a fresh one and try again';
    case 'validation_failed':
    case 'validation':
      return 'the booking details were rejected; reconfirm location, service, date, time, name, and phone';
    default:
      return 'the booking system could not complete that; the clinic will confirm shortly';
  }
}

export class CloneBookingsClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly onEvent: ((event: Record<string, unknown>) => void) | undefined;

  constructor(opts: {
    clone: CloneBookingsEnv;
    fetchFn?: typeof fetch;
    onEvent?: (event: Record<string, unknown>) => void;
  }) {
    this.baseUrl = opts.clone.baseUrl.replace(/\/+$/, '');
    this.fetchFn = opts.fetchFn ?? fetch;
    this.onEvent = opts.onEvent;
  }

  private log(event: Record<string, unknown>): void {
    this.onEvent?.({ kind: 'clone-bookings', ...event });
  }

  /**
   * Book one slot on the clone: resolve Location → roster → Procedure by
   * name, re-check the requested time against live availability, then
   * hold → confirm. Failures are speakable reasons, never throws.
   */
  async book(slot: ProposedSlot, opts: { idempotencyKey: string }): Promise<BookingOutcome> {
    try {
      const locations = envelopeData((await getJson(this.fetchFn, `${this.baseUrl}/locations`)).json);
      if (!Array.isArray(locations)) {
        return { ok: false, reason: 'the booking system could not be reached; the clinic will confirm shortly' };
      }
      const location = (locations as NamedRow[]).find((l) =>
        nameMatches(String(l.name ?? ''), slot.location),
      );
      if (!location) {
        const names = (locations as NamedRow[]).map((l) => shortName(String(l.name ?? ''))).join(' or ');
        return { ok: false, reason: `unknown location; ask the caller to choose ${names}` };
      }

      const [rosterRaw, proceduresRaw] = await Promise.all([
        getJson(this.fetchFn, `${this.baseUrl}/locations/${location.id}/doctors`),
        getJson(this.fetchFn, `${this.baseUrl}/locations/${location.id}/procedures`),
      ]);
      const roster = envelopeData(rosterRaw.json);
      const procedures = envelopeData(proceduresRaw.json);
      if (!Array.isArray(roster) || roster.length === 0 || !Array.isArray(procedures)) {
        return { ok: false, reason: 'the booking system could not complete that; the clinic will confirm shortly' };
      }
      // No auto-select (spec §2, Picktime `auto_select_staff:false`
      // precedent): with several roster rows the caller must choose — the
      // voice dialogue asks, mirroring the Picktime `pick-a-doctor` contract.
      if ((roster as NamedRow[]).length > 1) {
        return { ok: false, reason: 'more than one doctor is live; ask the caller which doctor they want' };
      }
      const doctor = (roster as NamedRow[])[0]!;
      const procedure = (procedures as NamedRow[]).find((p) =>
        nameMatches(String(p.name ?? ''), slot.service),
      );
      if (!procedure) {
        return { ok: false, reason: 'unknown service; offer only the services listed in the clinic guide' };
      }

      const availUrl =
        `${this.baseUrl}/availability?location_id=${encodeURIComponent(location.id)}` +
        `&roster_id=${encodeURIComponent(doctor.id)}` +
        `&procedure_id=${encodeURIComponent(procedure.id)}` +
        `&date=${encodeURIComponent(slot.date)}`;
      const avail = await getJson(this.fetchFn, availUrl);
      const availData = envelopeData(avail.json) as { slots?: AvailabilitySlot[] } | null;
      const slots = Array.isArray(availData?.slots) ? availData!.slots! : [];
      const wantHm = normalizeTime(slot.time).replace(':', '');
      const match = slots.find((s) => s.local_int.endsWith(wantHm));
      if (!match) {
        return { ok: false, reason: 'that Slot is not in live availability; offer only times from the availability block' };
      }

      const holdRes = await this.fetchFn(`${this.baseUrl}/holds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: location.id,
          roster_id: doctor.id,
          procedure_id: procedure.id,
          slot_start: match.start_utc,
        }),
      });
      const holdJson = await holdRes.json().catch(() => null);
      if (!holdRes.ok) {
        this.log({ event: 'http', path: '/holds', status: holdRes.status });
        return { ok: false, reason: failureReason(holdRes.status, holdJson) };
      }
      const holdKey = (envelopeData(holdJson) as { key?: string } | null)?.key;
      if (!holdKey) {
        return { ok: false, reason: 'the booking system could not complete that; the clinic will confirm shortly' };
      }

      const bookRes = await this.fetchFn(`${this.baseUrl}/bookings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': opts.idempotencyKey,
        },
        body: JSON.stringify({
          hold_key: holdKey,
          patient_name: slot.callerName,
          patient_phone: toE164(slot.callerPhone),
        }),
      });
      const bookJson = await bookRes.json().catch(() => null);
      this.log({ event: 'http', path: '/bookings', status: bookRes.status });
      if (bookRes.ok) return { ok: true };
      return { ok: false, reason: failureReason(bookRes.status, bookJson) };
    } catch (err) {
      this.log({
        event: 'error',
        path: '/bookings',
        detail: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, reason: 'the booking system could not be reached; the clinic will confirm shortly' };
    }
  }
}
