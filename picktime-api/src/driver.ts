/** Single seam behind the public HTTP boundary. Page internals never leak past this. */

export interface ServiceEntry {
  id: string;
  name: string;
  durationMin: number;
  cost: number;
}

export interface DoctorEntry {
  id: string;
  name: string;
}

export interface LocationEntry {
  id: string;
  name: string;
}

export interface Directory {
  services: ServiceEntry[];
  doctors: DoctorEntry[];
  locations: LocationEntry[];
  /** Live contact prefs re-read per call; e.g. ["firstName"], maybe + phone/email. */
  requiredContactFields: string[];
  fetchedAt: string;
}

export interface SlotEntry {
  serviceId: string;
  doctorId: string;
  locationId: string;
  /** ISO local `YYYY-MM-DDTHH:mm:00`; timezone rides top-level, never per-slot math. */
  start: string;
}

export interface HoldRecord {
  holdId: string;
  serviceId: string;
  doctorId: string;
  locationId: string;
  slotStart: string;
  expiresAt: string;
}

export interface BookingRecord {
  bookingId: string;
  serviceId: string;
  doctorId: string;
  locationId: string;
  slotStart: string;
}

export interface ConfirmInput {
  serviceId: string;
  doctorId: string;
  locationId: string;
  slotStart: string;
  patientName: string;
  patientPhone: string;
  extraContact?: Record<string, string>;
}

export interface ConfirmHeldInput {
  holdId: string;
  serviceId: string;
  doctorId: string;
  locationId: string;
  slotStart: string;
  patientName: string;
  patientPhone: string;
  extraContact?: Record<string, string>;
}

/** One page session's worth of operations; all reuse one navigation, bootstrap, and directory load. */
export interface DriverSession {
  getDirectory(): Promise<Directory>;
  listSlots(args: {
    serviceId: string;
    doctorId: string;
    locationId: string;
    from: string;
    to: string;
  }): Promise<{ slots: SlotEntry[]; fetchedAt: string }>;
  holdSlot(args: { serviceId: string; doctorId: string; locationId: string; slotStart: string }): Promise<HoldRecord>;
  heartbeat(holdId: string): Promise<void>;
  releaseHold(holdId: string): Promise<void>;
  confirmBooking(args: ConfirmHeldInput | ({ holdId?: never } & ConfirmInput)): Promise<BookingRecord>;
}

export interface PicktimeDriver {
  checkHealth(): Promise<void>;
  /**
   * One isolated page session per public API request: a single navigation and
   * a single directory load shared by every operation the request performs.
   * Retried once on transient (timeout/5xx) failures, but never once a write
   * has started, so a retry can never double-hold or double-save.
   */
  withSession<T>(fn: (session: DriverSession) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}
