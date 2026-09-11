import type { BookingOutcome, ProposedSlot } from './app.ts';

const META_TTL_MS = 5 * 60_000;
const SLOTS_TTL_MS = 30_000;
const READ_ATTEMPTS = 5;

export interface AppointmentsEnv {
  baseUrl: string;
  windowDays: number;
}

interface DirectoryEntry {
  id: string;
  name: string;
}

interface MetaResponse {
  timeZone: string;
  fetchedAt: string;
  locations: DirectoryEntry[];
  services: DirectoryEntry[];
  doctors: DirectoryEntry[];
}

interface LiveSlot {
  serviceId: string;
  doctorId: string;
  locationId: string;
  start: string;
}

interface SlotsResponse {
  timeZone: string;
  fetchedAt: string;
  slots: LiveSlot[];
  reason?: string;
}

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

function normalizeTime(raw: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return raw.trim();
  return `${match[1]!.padStart(2, '0')}:${match[2]}`;
}

/** Indian mobile input to E.164: local `98409 50950` or `098409…` becomes `+9198409…`. */
export function toE164(raw: string): string {
  const cleaned = raw.replace(/[\s().-]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return cleaned;
}

async function failureReason(res: Response): Promise<string> {
  if (res.status === 429) return 'the booking system is busy; ask the caller to try again in a moment';
  let code = '';
  try {
    const body = (await res.json()) as { error?: unknown };
    code = typeof body.error === 'string' ? body.error : '';
  } catch {
    code = '';
  }
  switch (code) {
    case 'slot-taken':
      return 'that time was just taken; offer another time from the availability block';
    case 'invented-slot':
      return 'that Slot is not in live availability; offer only times from the availability block';
    case 'page-down':
    case 'save-failed':
      return 'the booking system could not complete that; the clinic will confirm shortly';
    case 'pick-a-doctor':
      return 'more than one doctor is live; ask the caller which doctor they want';
    case 'conflict':
    case 'validation':
      return 'the booking details were rejected; reconfirm location, service, date, time, name, and phone';
    default:
      return 'the booking could not be completed; the clinic will confirm shortly';
  }
}

/**
 * HTTP client for the deployed Picktime Tool API. Availability is read live
 * (short cache so a Turn does not pay for more than one browser read) and a
 * booking is always re-checked against the live Slot list before the save.
 */
export class AppointmentsClient {
  private readonly baseUrl: string;
  private readonly windowDays: number;
  private readonly fetchFn: typeof fetch;
  private readonly onEvent: ((event: Record<string, unknown>) => void) | undefined;
  private metaCache: { at: number; value: MetaResponse } | null = null;
  private slotsCache: { at: number; value: SlotsResponse } | null = null;

  constructor(opts: {
    appointments: AppointmentsEnv;
    fetchFn?: typeof fetch;
    /** Console handoff channel: one JSON line per booking-API request and error. */
    onEvent?: (event: Record<string, unknown>) => void;
  }) {
    this.baseUrl = opts.appointments.baseUrl.replace(/\/+$/, '');
    this.windowDays = opts.appointments.windowDays;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.onEvent = opts.onEvent;
  }

  private log(event: Record<string, unknown>): void {
    this.onEvent?.({ kind: 'appointments', ...event });
  }

  private async errorCode(res: Response): Promise<string | undefined> {
    try {
      const body = (await res.clone().json()) as { error?: unknown };
      return typeof body.error === 'string' ? body.error : undefined;
    } catch {
      return undefined;
    }
  }

  private async readJson<T>(path: string): Promise<T> {
    let lastErr: unknown = new Error('appointments-unreachable');
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
      const started = Date.now();
      try {
        const res = await this.fetchFn(`${this.baseUrl}${path}`);
        const ms = Date.now() - started;
        if (res.ok) {
          this.log({ event: 'http', path, attempt: attempt + 1, status: res.status, ms });
          return (await res.json()) as T;
        }
        const error = await this.errorCode(res);
        this.log({ event: 'http', path, attempt: attempt + 1, status: res.status, error, ms });
        lastErr = new Error(`appointments-http-${res.status}`);
        if (res.status !== 429 && res.status !== 502 && res.status !== 503) break;
      } catch (err) {
        this.log({
          event: 'error',
          path,
          attempt: attempt + 1,
          ms: Date.now() - started,
          detail: err instanceof Error ? err.message : String(err),
        });
        lastErr = err;
      }
    }
    throw lastErr;
  }

  private async meta(): Promise<MetaResponse> {
    if (this.metaCache && Date.now() - this.metaCache.at < META_TTL_MS) {
      this.log({ event: 'cache', resource: 'meta', hit: true });
      return this.metaCache.value;
    }
    const value = await this.readJson<MetaResponse>('/v1/meta');
    this.metaCache = { at: Date.now(), value };
    return value;
  }

  private async slots(): Promise<SlotsResponse> {
    if (this.slotsCache && Date.now() - this.slotsCache.at < SLOTS_TTL_MS) {
      this.log({ event: 'cache', resource: 'slots', hit: true });
      return this.slotsCache.value;
    }
    const meta = await this.meta();
    const from = isoDateInTimeZone(new Date(), meta.timeZone);
    const to = addDays(from, this.windowDays - 1);
    const perService = await Promise.all(
      meta.services.map((service) =>
        this.readJson<SlotsResponse>(
          `/v1/get_available_slots?serviceId=${encodeURIComponent(service.id)}&from=${from}&to=${to}`,
        ),
      ),
    );
    const slots = perService.flatMap((part) => part.slots);
    const fetchedAt = perService.reduce((latest, part) => (part.fetchedAt > latest ? part.fetchedAt : latest), '');
    const value: SlotsResponse = {
      timeZone: perService[0]?.timeZone ?? meta.timeZone,
      fetchedAt,
      slots,
      ...(slots.length === 0 ? { reason: 'none-available' } : {}),
    };
    this.slotsCache = { at: Date.now(), value };
    this.log({ event: 'result', resource: 'slots', count: slots.length, fetchedAt });
    return value;
  }

  /** Assistant-facing Availability block; only these Slots exist for the next Turns. */
  async availabilityBlock(): Promise<string> {
    const meta = await this.meta();
    const live = await this.slots();
    const header = `AVAILABILITY (fetched ${live.fetchedAt}, timezone ${live.timeZone} — only these slots exist)`;
    if (live.slots.length === 0) {
      return `${header}\n- none: no Slots are open in the next ${this.windowDays} days. Do not offer any times.`;
    }
    const serviceName = new Map(meta.services.map((s) => [s.id, s.name]));
    const locationName = new Map(meta.locations.map((l) => [l.id, shortName(l.name)]));
    const groups = new Map<string, string[]>();
    for (const slot of live.slots) {
      const key = `${locationName.get(slot.locationId) ?? 'unknown location'} · ${serviceName.get(slot.serviceId) ?? 'unknown service'} · ${slot.start.slice(0, 10)}`;
      const times = groups.get(key) ?? [];
      times.push(slot.start.slice(11, 16));
      groups.set(key, times);
    }
    const lines = [...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, times]) => `- ${key}: ${times.join(' ')}`);
    return [header, '- location · service · date: times (24-hour HH:MM)', ...lines].join('\n');
  }

  /**
   * Save a Booking: resolve the LLM's names to live IDs, match the proposed
   * start against live Availability, then confirm. Failures come back as
   * speakable reasons instead of throwing, so the Turn always answers.
   */
  async book(slot: ProposedSlot, opts: { idempotencyKey: string }): Promise<BookingOutcome> {
    try {
      const meta = await this.meta();
      const live = await this.slots();
      const service = meta.services.find((s) => nameMatches(s.name, slot.service));
      if (!service) {
        return { ok: false, reason: 'unknown service; offer only the services listed in the clinic guide' };
      }
      const location = meta.locations.find((l) => nameMatches(l.name, slot.location));
      if (!location) {
        const names = meta.locations.map((l) => shortName(l.name)).join(' or ');
        return { ok: false, reason: `unknown location; ask the caller to choose ${names}` };
      }
      const start = `${slot.date}T${normalizeTime(slot.time)}:00`;
      const match = live.slots.find(
        (s) => s.serviceId === service.id && s.locationId === location.id && s.start === start,
      );
      if (!match) {
        return { ok: false, reason: 'that Slot is not in live availability; offer only times from the availability block' };
      }
      const postStarted = Date.now();
      const res = await this.fetchFn(`${this.baseUrl}/v1/book_appointment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': opts.idempotencyKey,
        },
        body: JSON.stringify({
          serviceId: match.serviceId,
          doctorId: match.doctorId,
          locationId: match.locationId,
          slotStart: match.start,
          patientName: slot.callerName,
          patientPhone: toE164(slot.callerPhone),
        }),
      });
      this.log({
        event: 'http',
        path: '/v1/book_appointment',
        method: 'POST',
        status: res.status,
        error: res.ok ? undefined : await this.errorCode(res),
        ms: Date.now() - postStarted,
      });
      if (res.ok) return { ok: true };
      return { ok: false, reason: await failureReason(res) };
    } catch (err) {
      this.log({
        event: 'error',
        path: '/v1/book_appointment',
        detail: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, reason: 'the booking system could not be reached; the clinic will confirm shortly' };
    }
  }
}
