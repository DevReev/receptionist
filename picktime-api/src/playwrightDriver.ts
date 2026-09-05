import { chromium } from 'playwright';
import type { APIRequestContext, Browser, BrowserContext, Page } from 'playwright';
import type {
  BookingRecord,
  ConfirmHeldInput,
  ConfirmInput,
  Directory,
  HoldRecord,
  PicktimeDriver,
  SlotEntry,
} from './driver.ts';
import { inventedSlot, pageDown, saveFailed, slotTaken, unknownDoctor, unknownLocation, unknownService, validation } from './errors.ts';
import { eachDateOnly, isoToSlotInt, normalizeSlotStart, slotIntToISO } from './time.ts';

export interface PlaywrightDriverOptions {
  pageId: string;
  navigationTimeoutMs?: number;
  actionTimeoutMs?: number;
  /** Headed Chromium for watched runs. Booking is XHR, not clicks: the window shows page loads, not the save itself. */
  headed?: boolean;
}

interface Bootstrap {
  scanToken: string;
  browserId: string;
  csrf: string;
}
interface ParsedDirectory {
  services: Array<{ id: string; name: string; durationMin: number; cost: number }>;
  doctors: Array<{ id: string; name: string }>;
  locations: Array<{ id: string; name: string }>;
  accountId: string;
  requiredContactFields: string[];
  slotGranularity: number;
  timeZone: string;
}

const BASE = 'https://www.picktime.com';
const AUTH_ERROR = 'Auth token validation error';

/** Playwright-driven Chromium fronting the Tool API (ADR-0001). XHR surface per research. */
export class PlaywrightDriver implements PicktimeDriver {
  #browser: Browser | null = null;
  #pageId: string;
  #navigationTimeoutMs: number;
  #actionTimeoutMs: number;
  #headed: boolean;

  constructor(options: PlaywrightDriverOptions) {
    this.#pageId = options.pageId;
    this.#navigationTimeoutMs = options.navigationTimeoutMs ?? 10_000;
    this.#actionTimeoutMs = options.actionTimeoutMs ?? 5_000;
    this.#headed = options.headed ?? false;
  }

  async checkHealth(): Promise<void> {
    const browser = await this.ensureBrowser();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      try {
        const response = await page.goto(`${BASE}/${this.#pageId}`, {
          waitUntil: 'domcontentloaded',
          timeout: this.#navigationTimeoutMs,
        });
        if (!response || !response.ok()) throw new Error(`page responded ${response?.status() ?? 'without response'}`);
      } catch (err) {
        // Screenshots on failure only; success paths never capture. No video.
        const shot = await page.screenshot().catch(() => undefined);
        const suffix = shot ? ` (screenshot ${shot.byteLength}b)` : '';
        throw pageDown(`${err instanceof Error ? err.message : String(err)}${suffix}`);
      }
    } finally {
      await context.close();
    }
  }

  async getDirectory(): Promise<Directory> {
    return this.withAuthed(async (request, bootstrap) => {
      const parsed = await this.loadParsedDirectory(request, bootstrap);
      return {
        services: parsed.services.map((s) => ({ id: s.id, name: s.name, durationMin: s.durationMin, cost: s.cost })),
        doctors: parsed.doctors.map((d) => ({ id: d.id, name: d.name })),
        locations: parsed.locations.map((l) => ({ id: l.id, name: l.name })),
        requiredContactFields: [...parsed.requiredContactFields],
        fetchedAt: new Date().toISOString(),
      };
    });
  }

  async listSlots(args: {
    serviceId: string;
    doctorId: string;
    locationId: string;
    from: string;
    to: string;
  }): Promise<{ slots: SlotEntry[]; fetchedAt: string }> {
    return this.withAuthed(async (request, bootstrap) => {
      const parsed = await this.loadParsedDirectory(request, bootstrap);
      const service = parsed.services.find((s) => s.id === args.serviceId);
      if (!service) throw unknownService(args.serviceId);
      const doctor = parsed.doctors.find((d) => d.id === args.doctorId);
      if (!doctor) throw unknownDoctor(args.doctorId);
      if (!parsed.locations.some((l) => l.id === args.locationId)) throw unknownLocation(args.locationId);
      // The page answers one day per query (weekend starts fall back to earliest),
      // so fan out per day and keep only slots inside the requested window.
      const slots: SlotEntry[] = [];
      for (const day of eachDateOnly(args.from, args.to)) {
        slots.push(...(await this.fetchDay(request, bootstrap, parsed, args.serviceId, args.doctorId, args.locationId, day)));
      }
      return { slots, fetchedAt: new Date().toISOString() };
    });
  }

  async holdSlot(args: { serviceId: string; doctorId: string; locationId: string; slotStart: string }): Promise<HoldRecord> {
    const start = normalizeSlotStart(args.slotStart);
    return this.withAuthed(async (request, bootstrap) => {
      const parsed = await this.loadParsedDirectory(request, bootstrap);
      return this.holdVia(request, bootstrap, parsed, {
        serviceId: args.serviceId,
        doctorId: args.doctorId,
        locationId: args.locationId,
        slotStart: start,
      });
    });
  }

  /** Hold and its follow-ups must share one session: the page ties blockers to the bootstrap. */
  private async holdVia(
    request: APIRequestContext,
    bootstrap: Bootstrap,
    parsed: ParsedDirectory,
    args: { serviceId: string; doctorId: string; locationId: string; slotStart: string },
  ): Promise<HoldRecord> {
    const service = parsed.services.find((s) => s.id === args.serviceId);
    if (!service) throw unknownService(args.serviceId);
    if (!parsed.doctors.some((d) => d.id === args.doctorId)) throw unknownDoctor(args.doctorId);
    if (!parsed.locations.some((l) => l.id === args.locationId)) throw unknownLocation(args.locationId);
    const day = args.slotStart.slice(0, 10);
    const availability = await this.listSlotsVia(request, bootstrap, parsed, args.serviceId, args.doctorId, args.locationId, day, day);
    if (!availability.some((s) => s.start === args.slotStart)) throw inventedSlot(args.slotStart);
    const slotInt = isoToSlotInt(args.slotStart);
    const endInt = addMinutesToSlotInt(slotInt, service.durationMin);
    let payload: Record<string, unknown>;
    try {
      payload = await this.apiPost(request, bootstrap, '/endpoint/1.0.0/ia/holdSlot', {
        accountKey: this.#pageId,
        type: 'service',
        staffKey: args.doctorId,
        serviceKey: args.serviceId,
        startDateAndTimeGMT: slotInt,
        endDateAndTimeGMT: endInt,
        timezone: parsed.timeZone,
        anyStaff: false,
        locationId: args.locationId,
      });
    } catch (err) {
      throw mapHoldError(err, args.slotStart);
    }
    const data = (payload.data ?? {}) as Record<string, unknown>;
    const blockerKey = typeof data.blockerKey === 'string' ? data.blockerKey : undefined;
    if (!blockerKey) throw mapHoldError(new Error('hold rejected without blocker'), args.slotStart);
    return {
      holdId: blockerKey,
      serviceId: args.serviceId,
      doctorId: args.doctorId,
      locationId: args.locationId,
      slotStart: args.slotStart,
      expiresAt: expiresToISO(data.expiresAt, parsed.timeZone),
    };
  }

  async heartbeat(holdId: string): Promise<void> {
    await this.withAuthed(async (request, bootstrap) => {
      await this.apiPost(request, bootstrap, '/endpoint/1.0.0/ia/heartbeatSlot', { blockerKeys: [holdId] });
    });
  }

  async releaseHold(holdId: string): Promise<void> {
    await this.withAuthed(async (request, bootstrap) => {
      await this.releaseVia(request, bootstrap, holdId);
    });
  }

  private async releaseVia(request: APIRequestContext, bootstrap: Bootstrap, holdId: string): Promise<void> {
    await this.apiPost(request, bootstrap, '/endpoint/1.0.0/ia/releaseSlot', { blockerKey: holdId });
  }

  async confirmBooking(args: ConfirmHeldInput | ({ holdId?: never } & ConfirmInput)): Promise<BookingRecord> {
    if ('holdId' in args && args.holdId !== undefined) {
      const held = args as ConfirmHeldInput;
      return this.withAuthed(async (request, bootstrap) => {
        const parsed = await this.loadParsedDirectory(request, bootstrap);
        return this.saveVia(request, bootstrap, parsed, {
          blockerKey: held.holdId,
          serviceId: held.serviceId,
          doctorId: held.doctorId,
          locationId: held.locationId,
          slotStart: normalizeSlotStart(held.slotStart),
          patientName: held.patientName,
          patientPhone: held.patientPhone,
          extraContact: held.extraContact,
        });
      });
    }
    const direct = args as ConfirmInput;
    const slotStart = normalizeSlotStart(direct.slotStart);
    return this.withAuthed(async (request, bootstrap) => {
      const parsed = await this.loadParsedDirectory(request, bootstrap);
      const hold = await this.holdVia(request, bootstrap, parsed, {
        serviceId: direct.serviceId,
        doctorId: direct.doctorId,
        locationId: direct.locationId,
        slotStart,
      });
      try {
        return await this.saveVia(request, bootstrap, parsed, {
          blockerKey: hold.holdId,
          serviceId: direct.serviceId,
          doctorId: direct.doctorId,
          locationId: direct.locationId,
          slotStart,
          patientName: direct.patientName,
          patientPhone: direct.patientPhone,
          extraContact: direct.extraContact,
        });
      } catch (err) {
        await this.releaseVia(request, bootstrap, hold.holdId).catch(() => {});
        throw err;
      }
    });
  }

  private async saveVia(
    request: APIRequestContext,
    bootstrap: Bootstrap,
    parsed: ParsedDirectory,
    args: {
      blockerKey: string;
      serviceId: string;
      doctorId: string;
      locationId: string;
      slotStart: string;
      patientName: string;
      patientPhone: string;
      extraContact?: Record<string, string>;
    },
  ): Promise<BookingRecord> {
    const service = parsed.services.find((s) => s.id === args.serviceId);
    if (!service) throw unknownService(args.serviceId);
    const extra = args.extraContact ?? {};
    let payload: Record<string, unknown>;
    try {
      payload = await this.apiPost(request, bootstrap, '/endpoint/1.0.0/ia/save/event', {
        account_id: parsed.accountId || this.#pageId,
        type: 'appointment',
        services: [args.serviceId],
        team: [args.doctorId],
        location: args.locationId,
        start_date_time: isoToSlotInt(args.slotStart),
        duration: service.durationMin,
        cost: service.cost,
        timezone: parsed.timeZone,
        fname: args.patientName,
        lname: extra.lastName ?? null,
        email: extra.email ?? null,
        mobile_number: args.patientPhone,
        address: extra.address ?? null,
        notes: extra.comments ?? null,
        slotBlockerKey: args.blockerKey,
        pay_later: true,
        send_sms: true,
      });
    } catch (err) {
      throw mapSaveError(err, args.slotStart);
    }
    const data = (payload.data ?? {}) as Record<string, unknown>;
    const bookingId =
      typeof data.booking_id === 'string'
        ? data.booking_id
        : typeof data.id === 'string'
          ? data.id
          : typeof data.eventId === 'string'
            ? data.eventId
            : args.blockerKey;
    return { bookingId, serviceId: args.serviceId, doctorId: args.doctorId, locationId: args.locationId, slotStart: args.slotStart };
  }

  private async listSlotsVia(
    request: APIRequestContext,
    bootstrap: Bootstrap,
    parsed: ParsedDirectory,
    serviceId: string,
    doctorId: string,
    locationId: string,
    from: string,
    to: string,
  ): Promise<SlotEntry[]> {
    const service = parsed.services.find((s) => s.id === serviceId);
    if (!service) throw unknownService(serviceId);
    const slots: SlotEntry[] = [];
    for (const day of eachDateOnly(from, to)) {
      slots.push(...(await this.fetchDay(request, bootstrap, parsed, serviceId, doctorId, locationId, day)));
    }
    return slots;
  }

  private async fetchDay(
    request: APIRequestContext,
    bootstrap: Bootstrap,
    parsed: ParsedDirectory,
    serviceId: string,
    doctorId: string,
    locationId: string,
    day: string,
  ): Promise<SlotEntry[]> {
    const service = parsed.services.find((s) => s.id === serviceId);
    if (!service) throw unknownService(serviceId);
    const compact = day.replaceAll('-', '');
    const params = new URLSearchParams({
      dateAndTime: `${compact}0000`,
      endDate: `${compact}0000`,
      schedulerId: doctorId,
      locationId,
      duration: String(service.durationMin),
      slot: String(parsed.slotGranularity),
      offBooking: 'false',
      eventType: 'appointment',
      serviceClassId: serviceId,
      accountId: this.#pageId,
      timezone: parsed.timeZone,
      v3: 'true',
    });
    const payload = await this.slotsGet(request, bootstrap, `/endpoint/1.0.0/ia/slots?${params.toString()}`);
    const ints = Array.isArray(payload.data) ? (payload.data as Array<string | number>) : [];
    const slots: SlotEntry[] = [];
    for (const n of ints) {
      const start = slotIntToISO(String(n));
      if (start.slice(0, 10) === day) slots.push({ serviceId, doctorId, locationId, start });
    }
    return slots;
  }

  private async loadParsedDirectory(request: APIRequestContext, bootstrap: Bootstrap): Promise<ParsedDirectory> {
    const load = await this.apiGet(request, bootstrap, `/endpoint/1.0.0/ia/loadBookingPage?_=${Date.now()}&bootstrap=true`);
    const flow = await this.apiGet(
      request,
      bootstrap,
      `/endpoint/1.0.0/ia/bookingFlowData?eventType=all&bookNowKey=${this.#pageId}&bookNowType=services`,
    );
    return parseDirectory(load, flow);
  }

  private async withAuthed<T>(fn: (request: APIRequestContext, bootstrap: Bootstrap) => Promise<T>): Promise<T> {
    const browser = await this.ensureBrowser();
    const runOnce = async (): Promise<T> => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(`${BASE}/${this.#pageId}`, {
          waitUntil: 'domcontentloaded',
          timeout: this.#navigationTimeoutMs,
        });
        const bootstrap = await extractBootstrap(page, context);
        return await fn(context.request, bootstrap);
      } finally {
        await context.close();
      }
    };
    try {
      return await runOnce();
    } catch (err) {
      if (isAuthError(err)) return runOnce();
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.#browser?.close().catch(() => {});
    this.#browser = null;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (!this.#browser) {
      this.#browser = await chromium.launch({
        headless: !this.#headed,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
    }
    return this.#browser;
  }

  private async apiGet(
    request: APIRequestContext,
    bootstrap: Bootstrap,
    path: string,
  ): Promise<{ data?: unknown; [key: string]: unknown }> {
    const res = await request.get(`${BASE}${path}`, {
      headers: { scanToken: bootstrap.scanToken, browserId: bootstrap.browserId },
      timeout: this.#actionTimeoutMs,
    });
    if (!res.ok()) throw pageDown(`page responded ${res.status()}`);
    const payload = (await res.json()) as { status?: boolean; message?: string; data?: unknown };
    if (payload.status !== true) throw pageDown(typeof payload.message === 'string' && payload.message ? payload.message : 'page rejected read');
    return payload;
  }

  /** Slot reads tolerate per-doctor empty windows as normal emptiness, never page-down. */
  private async slotsGet(
    request: APIRequestContext,
    bootstrap: Bootstrap,
    path: string,
  ): Promise<{ data?: unknown; [key: string]: unknown }> {
    const res = await request.get(`${BASE}${path}`, {
      headers: { scanToken: bootstrap.scanToken, browserId: bootstrap.browserId },
      timeout: this.#actionTimeoutMs,
    });
    if (!res.ok()) throw pageDown(`page responded ${res.status()}`);
    const payload = (await res.json()) as { status?: boolean; message?: string; data?: unknown };
    if (payload.status === true) return payload;
    if (/no available days|no slots|not available/i.test(typeof payload.message === 'string' ? payload.message : '')) {
      return { data: [] };
    }
    throw pageDown(typeof payload.message === 'string' && payload.message ? payload.message : 'page rejected read');
  }

  private async apiPost(
    request: APIRequestContext,
    bootstrap: Bootstrap,
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ data?: unknown; [key: string]: unknown }> {
    const res = await request.post(`${BASE}${path}`, {
      headers: {
        scanToken: bootstrap.scanToken,
        browserId: bootstrap.browserId,
        'X-CSRF-TOKEN': bootstrap.csrf,
        'Content-Type': 'application/json',
      },
      data: body,
      timeout: this.#actionTimeoutMs,
    });
    if (!res.ok()) throw pageDown(`page responded ${res.status()}`);
    const payload = (await res.json()) as { status?: boolean; message?: string; data?: unknown };
    if (payload.status !== true) {
      const message = typeof payload.message === 'string' ? payload.message : 'page rejected write';
      throw new Error(message || 'page rejected write');
    }
    return payload;
  }
}

async function extractBootstrap(page: Page, context: BrowserContext): Promise<Bootstrap> {
  const html = await page.content();
  const scan = html.match(/scanToken=`([^`]+)`/)?.[1] ?? html.match(/scanToken["']?\s*[:=]\s*["']([^"']+)/)?.[1];
  const bid = html.match(/browserId=`([^`]+)`/)?.[1];
  if (!scan || !bid) throw pageDown('page bootstrap missing auth markers');
  const cookies = await context.cookies();
  const csrf = cookies.find((c) => c.name === 'pt_csrf')?.value ?? '';
  return { scanToken: scan, browserId: bid, csrf };
}

function parseDirectory(load: Record<string, unknown>, flow: Record<string, unknown>): ParsedDirectory {
  const data = (load.data ?? {}) as Record<string, unknown>;
  const flowData = (flow.data ?? {}) as Record<string, unknown>;
  const rawServices = Array.isArray(data.services) ? (data.services as Array<Record<string, unknown>>) : [];
  const rawTeam = Array.isArray(data.team) ? (data.team as Array<Record<string, unknown>>) : [];
  const rawLocations = Array.isArray(data.locations) ? (data.locations as Array<Record<string, unknown>>) : [];
  const prefs = (data.bookingPreferences ?? flowData.bookingPreferences ?? {}) as Record<string, unknown>;
  const services = rawServices
    .filter((s) => s.status !== false)
    .map((s) => ({
      id: String(s.id ?? ''),
      name: String(s.name ?? ''),
      durationMin: typeof s.duration === 'number' ? s.duration : 30,
      cost: typeof s.cost === 'number' ? s.cost : 0,
    }))
    .filter((s) => s.id && s.name);
  const doctors = rawTeam
    .filter((t) => t.disable_public_booking !== true)
    .map((t) => ({
      id: String(t.id ?? ''),
      name: `${String(t.fname ?? '')} ${String(t.lname ?? '')}`.trim() || String(t.fname ?? t.id ?? ''),
    }))
    .filter((d) => d.id);
  const locations = rawLocations
    .map((loc) => {
      const name = [loc.name, loc.address, loc.city]
        .map((part) => (typeof part === 'string' ? part.trim() : ''))
        .filter((part) => part.length > 0)
        .join(', ');
      return { id: String(loc.id ?? ''), name: name || 'clinic' };
    })
    .filter((l) => l.id);
  if (services.length === 0 || doctors.length === 0 || locations.length === 0) {
    throw pageDown('page directory missing services, team, or locations');
  }
  const required = Array.isArray(prefs.contact_form_req_fields)
    ? (prefs.contact_form_req_fields as unknown[]).map((f) => String(f))
    : ['firstName'];
  return {
    services,
    doctors,
    locations,
    accountId: String((data.account as Record<string, unknown> | undefined)?.id ?? ''),
    requiredContactFields: required,
    slotGranularity: typeof prefs.booking_slot === 'number' ? prefs.booking_slot : 15,
    timeZone: typeof data.accountTimezoneID === 'string' ? data.accountTimezoneID : 'Asia/Kolkata',
  };
}

function mapHoldError(err: unknown, slotStart: string): Error {
  if (err instanceof Error && 'status' in err) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/taken|reserved|held|unavailable|someone else|gone/i.test(message)) return slotTaken(slotStart);
  if (/invalid|past|expired|not available/i.test(message)) return inventedSlot(slotStart);
  return pageDown(message);
}
function mapSaveError(err: unknown, slotStart: string): Error {
  if (err instanceof Error && 'status' in err) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/taken|reserved|held|unavailable|someone else|gone/i.test(message)) return slotTaken(slotStart);
  if (/required|missing|invalid|contact|phone|name/i.test(message)) {
    return validation(`booking rejected for ${slotStart}: ${message}`);
  }
  return saveFailed(slotStart, message);
}


function isAuthError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(AUTH_ERROR);
}

function addMinutesToSlotInt(slotInt: string, minutes: number): string {
  const y = Number(slotInt.slice(0, 4));
  const mo = Number(slotInt.slice(4, 6)) - 1;
  const d = Number(slotInt.slice(6, 8));
  const h = Number(slotInt.slice(8, 10));
  const mi = Number(slotInt.slice(10, 12));
  const dt = new Date(Date.UTC(y, mo, d, h, mi) + minutes * 60_000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}${pad(dt.getUTCHours())}${pad(dt.getUTCMinutes())}`;
}

function expiresToISO(value: unknown, timeZone: string): string {
  const text = String(value ?? '');
  const match = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (match) {
    const [, y, mo, d, h, mi, s] = match;
    if (timeZone === 'Asia/Kolkata') {
      const utcMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) - 330 * 60_000;
      return new Date(utcMs).toISOString();
    }
    return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  }
  return new Date(Date.now() + 10 * 60_000).toISOString();
}
