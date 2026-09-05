import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { ApiError, pickADoctor } from './errors.ts';
import type { ConfirmInput, HoldRecord, PicktimeDriver, SlotEntry } from './driver.ts';
import { MemoryDriver } from './memoryDriver.ts';
import { Pool } from './pool.ts';
import { openapiDocument } from './openapi.ts';
import { dateWindowDays, isDateOnly, isSlotStart, normalizeSlotStart, nowLocalISO } from './time.ts';

export interface AppDeps {
  bearerKey: string;
  checkReadiness: () => Promise<void>;
  logEvent: (event: Record<string, unknown>) => void;
  pageId?: string;
  staffId?: string;
  timeZone?: string;
  driver?: PicktimeDriver;
  pool?: Pool;
  holdTtlMs?: number;
  heartbeatIntervalMs?: number;
}

interface HeldEntry {
  hold: HoldRecord;
  expiresTimer: ReturnType<typeof setTimeout>;
  heartbeatTimer: ReturnType<typeof setInterval>;
}

interface StoredResponse {
  status: number;
  body: Record<string, unknown>;
}

const MAX_WINDOW_DAYS = 31;
const HOLD_TTL_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;
const NATURAL_KEY_MS = 10 * 60 * 1000;

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json());
  const pageId = deps.pageId ?? 'unknown';
  const timeZone = deps.timeZone ?? 'Asia/Kolkata';
  const driver = deps.driver ?? new MemoryDriver();
  const pool = deps.pool ?? new Pool(4);
  const holdTtlMs = deps.holdTtlMs ?? HOLD_TTL_MS;
  const heartbeatMs = deps.heartbeatIntervalMs ?? HEARTBEAT_MS;
  const held = new Map<string, HeldEntry>();
  const byKey = new Map<string, { hash: string; response: StoredResponse }>();
  const byNatural = new Map<string, { response: StoredResponse; storedAt: number }>();

  app.get('/health', async (_req: Request, res: Response) => {
    try {
      await deps.checkReadiness();
    } catch (err) {
      deps.logEvent({
        kind: 'health',
        pageId,
        status: 'degraded',
        reason: err instanceof Error ? err.message : String(err),
      });
      res.status(503).json({ status: 'degraded' });
      return;
    }
    res.json({ status: 'ok' });
  });

  app.use('/v1', (req: Request, res: Response, next: NextFunction) => {
    if (req.headers.authorization !== `Bearer ${deps.bearerKey}`) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  app.get('/v1/meta', async (_req: Request, res: Response) => {
    try {
      const directory = await pool.run(() => driver.getDirectory());
      res.json({
        timeZone,
        fetchedAt: directory.fetchedAt,
        location: directory.location,
        services: directory.services,
        doctors: directory.doctors,
      });
    } catch (err) {
      sendDriverError(res, deps.logEvent, pageId, 'meta', err);
    }
  });

  app.get('/v1/slots', async (req: Request, res: Response) => {
    const serviceId = singleQuery(req.query.serviceId);
    const doctorParam = singleQuery(req.query.doctorId);
    const from = singleQuery(req.query.from);
    const to = singleQuery(req.query.to);
    if (!serviceId) return validation(res, deps.logEvent, pageId, 'slots', 'serviceId is required');
    if (!from || !to) {
      return validation(res, deps.logEvent, pageId, 'slots', 'from and to (YYYY-MM-DD) are required');
    }
    if (!isDateOnly(from) || !isDateOnly(to)) {
      return validation(res, deps.logEvent, pageId, 'slots', 'from/to must be YYYY-MM-DD');
    }
    if (to < from) return validation(res, deps.logEvent, pageId, 'slots', 'to must not precede from');
    if (dateWindowDays(from, to) > MAX_WINDOW_DAYS) {
      return validation(res, deps.logEvent, pageId, 'slots', 'window capped at 31 days');
    }
    try {
      const doctorIds = await resolveDoctorIds(driver, pool, deps.staffId, doctorParam);
      const fetched = await pool.run(async () => {
        const perDoctor = await Promise.all(
          doctorIds.map((doctorId) => driver.listSlots({ serviceId, doctorId, from, to })),
        );
        const merged: SlotEntry[] = [];
        let fetchedAt = '';
        for (const part of perDoctor) {
          merged.push(...part.slots);
          if (part.fetchedAt > fetchedAt) fetchedAt = part.fetchedAt;
        }
        return { slots: merged, fetchedAt };
      });
      const cutoff = nowLocalISO(timeZone);
      const upcoming = fetched.slots
        .filter((s) => s.start.slice(0, 10) >= from && s.start.slice(0, 10) <= to && s.start >= cutoff)
        .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
      res.json({
        timeZone,
        fetchedAt: fetched.fetchedAt,
        slots: upcoming,
        ...(upcoming.length === 0 ? { reason: 'none-available' } : {}),
      });
    } catch (err) {
      sendDriverError(res, deps.logEvent, pageId, 'slots', err);
    }
  });

  app.post('/v1/holds', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const serviceId = asString(body.serviceId);
    const doctorParam = asString(body.doctorId);
    const slotRaw = asString(body.slotStart);
    if (!serviceId) return validation(res, deps.logEvent, pageId, 'hold', 'serviceId is required');
    if (!slotRaw || !isSlotStart(slotRaw)) {
      return validation(res, deps.logEvent, pageId, 'hold', 'slotStart must be YYYY-MM-DDTHH:mm:00');
    }
    const slotStart = normalizeSlotStart(slotRaw);
    try {
      const doctorId = await resolveSingleDoctor(driver, pool, deps.staffId, doctorParam);
      const hold = await pool.run(() => driver.holdSlot({ serviceId, doctorId, slotStart }));
      trackHold(hold);
      deps.logEvent({ kind: 'hold', pageId, holdId: hold.holdId, slotStart, doctorId });
      res.status(201).json({ ...hold, timeZone });
    } catch (err) {
      sendDriverError(res, deps.logEvent, pageId, 'hold', err, { slotStart });
    }
  });

  app.delete('/v1/holds/:id', async (req: Request, res: Response) => {
    const rawId = req.params.id;
    const holdParamId = Array.isArray(rawId) ? rawId[0] : rawId;
    const entry = held.get(holdParamId);
    if (!entry) {
      deps.logEvent({ kind: 'release', pageId, reason: 'unknown-hold', holdId: holdParamId });
      res.status(404).json({ error: 'unknown-hold', message: `unknown hold: ${holdParamId}` });
      return;
    }
    untrackHold(holdParamId);
    try {
      await pool.run(() => driver.releaseHold(holdParamId));
    } catch (err) {
      sendDriverError(res, deps.logEvent, pageId, 'release', err);
      return;
    }
    deps.logEvent({ kind: 'release', pageId, holdId: holdParamId });
    res.status(204).end();
  });

  app.get('/v1/openapi.json', (_req: Request, res: Response) => {
    res.json(openapiDocument);
  });

  app.post('/v1/bookings', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.dryRun === true) {
      await handleDryRun(body, res);
      return;
    }
    await handleConfirm(body, req.headers['idempotency-key'], res);
  });

  async function handleDryRun(body: Record<string, unknown>, res: Response): Promise<void> {
    const serviceId = asString(body.serviceId);
    const doctorParam = asString(body.doctorId);
    const slotRaw = asString(body.slotStart);
    if (!serviceId) {
      validation(res, deps.logEvent, pageId, 'booking', 'serviceId is required');
      return;
    }
    if (!slotRaw || !isSlotStart(slotRaw)) {
      validation(res, deps.logEvent, pageId, 'booking', 'slotStart must be YYYY-MM-DDTHH:mm:00');
      return;
    }
    const slotStart = normalizeSlotStart(slotRaw);
    try {
      const doctorId = await resolveSingleDoctor(driver, pool, deps.staffId, doctorParam);
      await pool.run(async () => {
        const hold = await driver.holdSlot({ serviceId, doctorId, slotStart });
        try {
          return hold;
        } finally {
          await driver.releaseHold(hold.holdId);
        }
      });
      deps.logEvent({ kind: 'booking', pageId, dryRun: true, slotStart, doctorId, held: true });
      res.json({ dryRun: true, held: true, saved: false, serviceId, doctorId, slotStart, timeZone });
    } catch (err) {
      sendDriverError(res, deps.logEvent, pageId, 'booking', err, { slotStart });
    }
  }

  async function handleConfirm(
    body: Record<string, unknown>,
    headerKey: unknown,
    res: Response,
  ): Promise<void> {
    const serviceId = asString(body.serviceId);
    const doctorParam = asString(body.doctorId);
    const slotRaw = asString(body.slotStart);
    const patientName = asString(body.patientName);
    const patientPhone = asString(body.patientPhone);
    const holdId = asString(body.holdId);
    const headerText = Array.isArray(headerKey) ? headerKey[0] : headerKey;
    const explicitKey =
      typeof headerText === 'string' && headerText.length > 0 ? headerText : asString(body.idempotencyKey);
    if (!serviceId && !holdId) {
      validation(res, deps.logEvent, pageId, 'booking', 'serviceId is required');
      return;
    }
    if (!holdId && (!slotRaw || !isSlotStart(slotRaw))) {
      validation(res, deps.logEvent, pageId, 'booking', 'slotStart must be YYYY-MM-DDTHH:mm:00');
      return;
    }
    if (!patientName) {
      validation(res, deps.logEvent, pageId, 'booking', 'patientName is required');
      return;
    }
    if (!patientPhone) {
      validation(res, deps.logEvent, pageId, 'booking', 'patientPhone is required');
      return;
    }
    try {
      if (holdId && !held.has(holdId)) {
        deps.logEvent({ kind: 'booking', pageId, reason: 'unknown-hold', holdId });
        res.status(404).json({ error: 'unknown-hold', message: `unknown hold: ${holdId}` });
        return;
      }
      const storedHold = holdId ? held.get(holdId)?.hold : undefined;
      const doctorId = storedHold?.doctorId ?? (await resolveSingleDoctor(driver, pool, deps.staffId, doctorParam));
      const slotStart = storedHold?.slotStart ?? normalizeSlotStart(slotRaw as string);
      const effectiveService = storedHold?.serviceId ?? serviceId;
      if (!effectiveService) {
        validation(res, deps.logEvent, pageId, 'booking', 'serviceId is required');
        return;
      }
      await enforceContactPrefs(body);
      const payloadHash = createHash('sha256')
        .update(JSON.stringify({ serviceId: effectiveService, doctorId, slotStart, patientName, patientPhone, holdId: holdId ?? null }))
        .digest('hex');
      if (explicitKey) {
        const seen = byKey.get(explicitKey);
        if (seen) {
          if (seen.hash !== payloadHash) {
            deps.logEvent({ kind: 'booking', pageId, reason: 'conflict', message: 'idempotency key re-used with different payload' });
            res.status(409).json({ error: 'conflict', message: 'idempotency key re-used with different payload' });
            return;
          }
          res.status(seen.response.status).json(seen.response.body);
          return;
        }
      }
      const naturalKey = `${patientPhone}|${effectiveService}|${doctorId}|${slotStart}`;
      const natural = byNatural.get(naturalKey);
      if (natural && Date.now() - natural.storedAt < NATURAL_KEY_MS) {
        if (explicitKey) byKey.set(explicitKey, { hash: payloadHash, response: natural.response });
        res.status(natural.response.status).json(natural.response.body);
        return;
      }
      const booking = await pool.run(() => {
        if (holdId) {
          untrackHold(holdId);
          return driver.confirmBooking({
            holdId,
            serviceId: effectiveService,
            doctorId,
            slotStart,
            patientName: patientName as string,
            patientPhone: patientPhone as string,
            extraContact: extraContactFrom(body),
          });
        }
        const input: ConfirmInput = {
          serviceId: effectiveService,
          doctorId,
          slotStart,
          patientName: patientName as string,
          patientPhone: patientPhone as string,
          extraContact: extraContactFrom(body),
        };
        return driver.confirmBooking(input);
      });
      const responseBody: Record<string, unknown> = {
        bookingId: booking.bookingId,
        serviceId: booking.serviceId,
        doctorId: booking.doctorId,
        slotStart: booking.slotStart,
        timeZone,
      };
      const stored: StoredResponse = { status: 201, body: responseBody };
      byNatural.set(naturalKey, { response: stored, storedAt: Date.now() });
      if (explicitKey) byKey.set(explicitKey, { hash: payloadHash, response: stored });
      deps.logEvent({ kind: 'booking', pageId, bookingId: booking.bookingId, slotStart: booking.slotStart, doctorId });
      res.status(201).json(responseBody);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'pick-a-doctor') {
        deps.logEvent({ kind: 'booking', pageId, reason: err.code, candidates: err.details?.candidates });
        res.status(err.status).json({ error: err.code, message: err.message, candidates: err.details?.candidates });
        return;
      }
      const entry = holdId ? held.get(holdId) : undefined;
      sendDriverError(res, deps.logEvent, pageId, 'booking', err, {
        slotStart: entry?.hold.slotStart ?? (typeof slotRaw === 'string' ? slotRaw : undefined),
      });
    }
  }

  async function enforceContactPrefs(body: Record<string, unknown>): Promise<void> {
    const directory = await pool.run(() => driver.getDirectory());
    const missing: string[] = [];
    for (const field of directory.requiredContactFields) {
      if (field === 'firstName') continue;
      if (field === 'mobileNumber') continue;
      if (!asString(body[field]) && !asString((body.contact as Record<string, unknown> | undefined)?.[field])) {
        missing.push(field);
      }
    }
    if (missing.length > 0) {
      throw new ApiError(422, 'validation', `missing required contact fields: ${missing.join(', ')}`, { missing });
    }
  }

  function trackHold(hold: HoldRecord): void {
    const expiresTimer = setTimeout(() => {
      const entry = held.get(hold.holdId);
      if (!entry) return;
      held.delete(hold.holdId);
      clearInterval(entry.heartbeatTimer);
      pool
        .run(() => driver.releaseHold(hold.holdId))
        .catch((err: unknown) => {
          deps.logEvent({ kind: 'hold', pageId, reason: 'release-failed', holdId: hold.holdId });
          void err;
        });
      deps.logEvent({ kind: 'hold', pageId, reason: 'expired', holdId: hold.holdId, slotStart: hold.slotStart });
    }, holdTtlMs);
    const heartbeatTimer = setInterval(() => {
      pool.run(() => driver.heartbeat(hold.holdId)).catch(() => {});
    }, heartbeatMs);
    if (typeof expiresTimer.unref === 'function') expiresTimer.unref();
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
    held.set(hold.holdId, { hold, expiresTimer, heartbeatTimer });
  }

  function untrackHold(holdId: string): void {
    const entry = held.get(holdId);
    if (!entry) return;
    clearTimeout(entry.expiresTimer);
    clearInterval(entry.heartbeatTimer);
    held.delete(holdId);
  }

  return app;
}

async function resolveDoctorIds(
  driver: PicktimeDriver,
  pool: Pool,
  configured: string | undefined,
  param: string | undefined,
): Promise<string[]> {
  if (param) return [param];
  if (configured) return [configured];
  const directory = await pool.run(() => driver.getDirectory());
  return directory.doctors.map((d) => d.id);
}

async function resolveSingleDoctor(
  driver: PicktimeDriver,
  pool: Pool,
  configured: string | undefined,
  param: string | undefined,
): Promise<string> {
  if (param) return param;
  if (configured) return configured;
  const directory = await pool.run(() => driver.getDirectory());
  if (directory.doctors.length === 1) return directory.doctors[0].id;
  throw pickADoctor(directory.doctors);
}

function singleQuery(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function extraContactFrom(body: Record<string, unknown>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const field of ['lastName', 'email', 'address', 'comments']) {
    const value = asString(body[field]);
    if (value) out[field] = value;
  }
  const nested = body.contact;
  if (nested && typeof nested === 'object') {
    for (const [key, value] of Object.entries(nested as Record<string, unknown>)) {
      const text = asString(value);
      if (text) out[key] = text;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function validation(
  res: Response,
  logEvent: (event: Record<string, unknown>) => void,
  pageId: string,
  kind: string,
  message: string,
): void {
  logEvent({ kind, pageId, reason: 'validation', message });
  res.status(422).json({ error: 'validation', message });
}

function sendDriverError(
  res: Response,
  logEvent: (event: Record<string, unknown>) => void,
  pageId: string,
  kind: string,
  err: unknown,
  extra?: Record<string, unknown>,
): void {
  if (err instanceof ApiError) {
    logEvent({ kind, pageId, reason: err.code, message: err.message, ...extra, ...err.details });
    if (err.status === 429) res.setHeader('Retry-After', '1');
    const body: Record<string, unknown> = { error: err.code, message: err.message };
    if (err.details?.candidates !== undefined) body.candidates = err.details.candidates;
    if (err.details?.missing !== undefined) body.missing = err.details.missing;
    res.status(err.status).json(body);
    return;
  }
  logEvent({ kind, pageId, reason: 'page-down', message: err instanceof Error ? err.message : String(err), ...extra });
  res.status(502).json({ error: 'page-down', message: 'booking page unavailable' });
}
