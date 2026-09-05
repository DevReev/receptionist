/** Single seam behind the public HTTP boundary. Page internals never leak past this. */

export interface ServiceEntry {
  id: string;
  name: string;
  durationMin: number;
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
  location: LocationEntry;
  /** Live contact prefs re-read per call; e.g. ["firstName"], maybe + phone/email. */
  requiredContactFields: string[];
  fetchedAt: string;
}

export interface SlotEntry {
  serviceId: string;
  doctorId: string;
  /** ISO local `YYYY-MM-DDTHH:mm:00`; timezone rides top-level, never per-slot math. */
  start: string;
}

export interface HoldRecord {
  holdId: string;
  serviceId: string;
  doctorId: string;
  slotStart: string;
  expiresAt: string;
}

export interface BookingRecord {
  bookingId: string;
  serviceId: string;
  doctorId: string;
  slotStart: string;
}

export interface ConfirmInput {
  serviceId: string;
  doctorId: string;
  slotStart: string;
  patientName: string;
  patientPhone: string;
  extraContact?: Record<string, string>;
}

export interface ConfirmHeldInput {
  holdId: string;
  serviceId: string;
  doctorId: string;
  slotStart: string;
  patientName: string;
  patientPhone: string;
  extraContact?: Record<string, string>;
}

export interface PicktimeDriver {
  checkHealth(): Promise<void>;
  getDirectory(): Promise<Directory>;
  listSlots(args: {
    serviceId: string;
    doctorId: string;
    from: string;
    to: string;
  }): Promise<{ slots: SlotEntry[]; fetchedAt: string }>;
  holdSlot(args: { serviceId: string; doctorId: string; slotStart: string }): Promise<HoldRecord>;
  heartbeat(holdId: string): Promise<void>;
  releaseHold(holdId: string): Promise<void>;
  confirmBooking(args: ConfirmHeldInput | ({ holdId?: never } & ConfirmInput)): Promise<BookingRecord>;
  close?(): Promise<void>;
}
