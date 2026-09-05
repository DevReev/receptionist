/** Typed client stub. Other projects book through this, never server code. */

export interface ClientOptions {
  baseUrl: string;
}

export interface ServiceEntry {
  id: string;
  name: string;
  durationMin: number;
}

export interface DoctorEntry {
  id: string;
  name: string;
}

export interface MetaResponse {
  timeZone: string;
  fetchedAt: string;
  locations: Array<{ id: string; name: string }>;
  services: ServiceEntry[];
  doctors: DoctorEntry[];
}

export interface SlotEntry {
  serviceId: string;
  doctorId: string;
  locationId: string;
  start: string;
}

export interface SlotsResponse {
  timeZone: string;
  fetchedAt: string;
  slots: SlotEntry[];
  reason?: string;
}

export interface HoldResponse {
  holdId: string;
  serviceId: string;
  doctorId: string;
  locationId: string;
  slotStart: string;
  expiresAt: string;
  timeZone: string;
}

export interface BookingResponse {
  bookingId: string;
  serviceId: string;
  doctorId: string;
  locationId: string;
  slotStart: string;
  timeZone: string;
}

export interface DryRunResponse {
  dryRun: true;
  held: true;
  saved: false;
  serviceId: string;
  doctorId: string;
  locationId: string;
  slotStart: string;
  timeZone: string;
}

export interface BookAppointmentArgs {
  serviceId: string;
  doctorId?: string;
  locationId: string;
  slotStart: string;
  patientName: string;
  patientPhone: string;
  idempotencyKey: string;
  dryRun?: boolean;
}

export interface Client {
  health(): Promise<{ status: string }>;
  meta(): Promise<MetaResponse>;
  slots(args: { serviceId: string; doctorId?: string; locationId?: string; from: string; to: string }): Promise<SlotsResponse>;
  getAvailableSlots(args: { serviceId: string; doctorId?: string; locationId?: string; from: string; to: string }): Promise<SlotsResponse>;
  hold(args: { serviceId: string; doctorId?: string; locationId: string; slotStart: string }): Promise<HoldResponse>;
  releaseHold(holdId: string): Promise<void>;
  book(args: {
    serviceId?: string;
    doctorId?: string;
    locationId?: string;
    slotStart?: string;
    holdId?: string;
    patientName: string;
    patientPhone: string;
    idempotencyKey?: string;
    dryRun?: boolean;
  }): Promise<BookingResponse | DryRunResponse>;
  bookAppointment(args: BookAppointmentArgs): Promise<BookingResponse | DryRunResponse>;
  openapi(): Promise<Record<string, unknown>>;
}

export function createClient(options: ClientOptions): Client {
  const base = options.baseUrl.replace(/\/$/, '');
  async function request<T>(path: string, init?: RequestInit, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const res = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
    if (res.status === 204) return undefined as T;
    const body = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
    if (!res.ok) {
      const detail = typeof body.message === 'string' ? `: ${body.message}` : '';
      throw new Error(`${path} failed with ${res.status} ${String(body.error ?? 'error')}${detail}`);
    }
    return body as T;
  }

  const getAvailableSlots = (args: {
    serviceId: string;
    doctorId?: string;
    locationId?: string;
    from: string;
    to: string;
  }): Promise<SlotsResponse> => {
    const params = new URLSearchParams({ serviceId: args.serviceId, from: args.from, to: args.to });
    if (args.doctorId) params.set('doctorId', args.doctorId);
    if (args.locationId) params.set('locationId', args.locationId);
    return request<SlotsResponse>(`/v1/get_available_slots?${params.toString()}`);
  };

  const postBooking = (path: string, args: {
    serviceId?: string;
    doctorId?: string;
    locationId?: string;
    slotStart?: string;
    holdId?: string;
    patientName: string;
    patientPhone: string;
    idempotencyKey?: string;
    dryRun?: boolean;
  }): Promise<BookingResponse | DryRunResponse> =>
    request<BookingResponse | DryRunResponse>(path, { method: 'POST', body: JSON.stringify(args) }, args.idempotencyKey);

  return {
    health: () => request<{ status: string }>('/health'),
    meta: () => request<MetaResponse>('/v1/meta'),
    slots: getAvailableSlots,
    getAvailableSlots,
    hold: (args) =>
      request<HoldResponse>('/v1/holds', {
        method: 'POST',
        body: JSON.stringify(args),
      }),
    releaseHold: (holdId) => request<void>(`/v1/holds/${holdId}`, { method: 'DELETE' }),
    book: (args) => postBooking('/v1/bookings', args),
    bookAppointment: (args) => postBooking('/v1/book_appointment', args),
    openapi: () => request<Record<string, unknown>>('/v1/openapi.json'),
  };
}
