import { randomUUID } from 'node:crypto';
import type {
  BookingRecord,
  ConfirmHeldInput,
  ConfirmInput,
  Directory,
  HoldRecord,
  PicktimeDriver,
  SlotEntry,
} from './driver.ts';
import { inventedSlot, pageDown, slotTaken, unknownDoctor, unknownService } from './errors.ts';
import { eachDateOnly, isDateOnly, normalizeSlotStart } from './time.ts';

const SERVICE = { id: 'svc-sample', name: 'Sample Service', durationMin: 30 };
const DOCTORS = [
  { id: 'doc-veer', name: 'Veer Maruthesh' },
  { id: 'doc-veer2', name: 'veer2' },
  { id: 'doc-veeer', name: 'veeer' },
];
const LOCATION = { id: 'loc-bobby-home', name: 'bobby home, nallurhalli, Bangalore' };

const HOLD_TTL_MS = 10 * 60 * 1000;

function isWeekday(dateOnly: string): boolean {
  const [y, m, d] = dateOnly.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow >= 1 && dow <= 5;
}

/** Deterministic weekday 09:00-16:30 IST slots every 15 min. No page ints leak out. */
function generateSlots(serviceId: string, doctorId: string, from: string, to: string): SlotEntry[] {
  const slots: SlotEntry[] = [];
  for (const date of eachDateOnly(from, to)) {
    if (!isWeekday(date)) continue;
    for (let h = 9; h < 17; h++) {
      for (const min of [0, 15, 30, 45]) {
        if (h === 16 && min > 30) continue;
        const start = `${date}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00`;
        slots.push({ serviceId, doctorId, start });
      }
    }
  }
  return slots;
}

export interface MemoryDriverOptions {
  down?: boolean;
  holdTtlMs?: number;
}

/** Offline driver for contract tests and default runs. Live page suites replace it. */
export class MemoryDriver implements PicktimeDriver {
  private holds = new Map<string, HoldRecord>();
  private booked = new Set<string>();
  private down: boolean;
  private holdTtlMs: number;

  constructor(options: MemoryDriverOptions = {}) {
    this.down = options.down ?? false;
    this.holdTtlMs = options.holdTtlMs ?? HOLD_TTL_MS;
  }

  setDown(down: boolean): void {
    this.down = down;
  }

  private key(serviceId: string, doctorId: string, slotStart: string): string {
    return `${serviceId}|${doctorId}|${normalizeSlotStart(slotStart)}`;
  }

  async checkHealth(): Promise<void> {
    if (this.down) throw pageDown('synthetic outage (memory driver)');
  }

  async getDirectory(): Promise<Directory> {
    if (this.down) throw pageDown('directory unreachable');
    return {
      services: [{ ...SERVICE }],
      doctors: DOCTORS.map((d) => ({ ...d })),
      location: { ...LOCATION },
      requiredContactFields: ['firstName'],
      fetchedAt: new Date().toISOString(),
    };
  }

  async listSlots(args: {
    serviceId: string;
    doctorId: string;
    from: string;
    to: string;
  }): Promise<{ slots: SlotEntry[]; fetchedAt: string }> {
    if (this.down) throw pageDown('slots unreachable');
    if (args.serviceId !== SERVICE.id) throw unknownService(args.serviceId);
    if (!DOCTORS.some((d) => d.id === args.doctorId)) throw unknownDoctor(args.doctorId);
    if (!isDateOnly(args.from) || !isDateOnly(args.to)) {
      throw pageDown('unreachable: invalid date window passed driver check');
    }
    const slots = generateSlots(args.serviceId, args.doctorId, args.from, args.to).filter(
      (s) => !this.booked.has(this.key(s.serviceId, s.doctorId, s.start)),
    );
    return { slots, fetchedAt: new Date().toISOString() };
  }

  async holdSlot(args: {
    serviceId: string;
    doctorId: string;
    slotStart: string;
  }): Promise<HoldRecord> {
    if (this.down) throw pageDown('hold unreachable');
    if (args.serviceId !== SERVICE.id) throw unknownService(args.serviceId);
    if (!DOCTORS.some((d) => d.id === args.doctorId)) throw unknownDoctor(args.doctorId);
    const start = normalizeSlotStart(args.slotStart);
    const availability = generateSlots(args.serviceId, args.doctorId, start.slice(0, 10), start.slice(0, 10));
    if (!availability.some((s) => s.start === start)) throw inventedSlot(start);
    const k = this.key(args.serviceId, args.doctorId, start);
    if (this.booked.has(k)) throw slotTaken(start);
    for (const h of this.holds.values()) {
      if (this.key(h.serviceId, h.doctorId, h.slotStart) === k) throw slotTaken(start);
    }
    const hold: HoldRecord = {
      holdId: randomUUID(),
      serviceId: args.serviceId,
      doctorId: args.doctorId,
      slotStart: start,
      expiresAt: new Date(Date.now() + this.holdTtlMs).toISOString(),
    };
    this.holds.set(hold.holdId, hold);
    return hold;
  }

  async heartbeat(holdId: string): Promise<void> {
    if (this.down) throw pageDown('heartbeat unreachable');
    const hold = this.holds.get(holdId);
    if (hold) {
      hold.expiresAt = new Date(Date.now() + this.holdTtlMs).toISOString();
    }
  }

  async releaseHold(holdId: string): Promise<void> {
    if (this.down) throw pageDown('release unreachable');
    this.holds.delete(holdId);
  }

  async confirmBooking(
    args: ConfirmHeldInput | ({ holdId?: never } & ConfirmInput),
  ): Promise<BookingRecord> {
    if (this.down) throw pageDown('save unreachable');
    if ('holdId' in args && args.holdId !== undefined) {
      const hold = this.holds.get(args.holdId);
      if (!hold) throw inventedSlot(args.holdId);
      const k = this.key(hold.serviceId, hold.doctorId, hold.slotStart);
      if (this.booked.has(k)) throw slotTaken(hold.slotStart);
      this.booked.add(k);
      this.holds.delete(args.holdId);
      return {
        bookingId: randomUUID(),
        serviceId: hold.serviceId,
        doctorId: hold.doctorId,
        slotStart: hold.slotStart,
      };
    }
    const input = args as ConfirmInput;
    const hold = await this.holdSlot({
      serviceId: input.serviceId,
      doctorId: input.doctorId,
      slotStart: input.slotStart,
    });
    try {
      return await this.confirmBooking({
        holdId: hold.holdId,
        serviceId: hold.serviceId,
        doctorId: hold.doctorId,
        slotStart: hold.slotStart,
        patientName: input.patientName,
        patientPhone: input.patientPhone,
        extraContact: input.extraContact,
      });
    } catch (err) {
      await this.releaseHold(hold.holdId).catch(() => {});
      throw err;
    }
  }

  /** Test hook: is this slot currently held? */
  hasHoldFor(serviceId: string, doctorId: string, slotStart: string): boolean {
    const k = this.key(serviceId, doctorId, slotStart);
    for (const h of this.holds.values()) {
      if (this.key(h.serviceId, h.doctorId, h.slotStart) === k) return true;
    }
    return false;
  }
}
