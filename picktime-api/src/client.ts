/** Typed client stub. Other projects book through this, never server code. */

export interface ClientOptions {
  baseUrl: string;
  bearerKey: string;
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
  location: { id: string; name: string };
  services: ServiceEntry[];
  doctors: DoctorEntry[];
}

export interface SlotEntry {
  serviceId: string;
  doctorId: string;
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
  slotStart: string;
  expiresAt: string;
  timeZone: string;
}

export interface BookingResponse {
  bookingId: string;
  serviceId: string;
  doctorId: string;
  slotStart: string;
  timeZone: string;
}

export interface DryRunResponse {
  dryRun: true;
  held: true;
  saved: false;
  serviceId: string;
  doctorId: string;
  slotStart: string;
  timeZone: string;
}

export interface Client {
  health(): Promise<{ status: string }>;
  meta(): Promise<MetaResponse>;
  slots(args: { serviceId: string; doctorId?: string; from: string; to: string }): Promise<SlotsResponse>;
  hold(args: { serviceId: string; doctorId?: string; slotStart: string }): Promise<HoldResponse>;
  releaseHold(holdId: string): Promise<void>;
  book(args: {
    serviceId?: string;
    doctorId?: string;
    slotStart?: string;
    holdId?: string;
    patientName: string;
    patientPhone: string;
    idempotencyKey?: string;
    dryRun?: boolean;
  }): Promise<BookingResponse | DryRunResponse>;
  openapi(): Promise<Record<string, unknown>>;
}

export function createClient(options: ClientOptions): Client {
  const base = options.baseUrl.replace(/\/$/, '');
  async function request<T>(path: string, init?: RequestInit, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.bearerKey}`,
      'content-type': 'application/json',
    };
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

  return {
    health: () => request<{ status: string }>('/health'),
    meta: () => request<MetaResponse>('/v1/meta'),
    slots: (args) => {
      const params = new URLSearchParams({ serviceId: args.serviceId, from: args.from, to: args.to });
      if (args.doctorId) params.set('doctorId', args.doctorId);
      return request<SlotsResponse>(`/v1/slots?${params.toString()}`);
    },
    hold: (args) =>
      request<HoldResponse>('/v1/holds', {
        method: 'POST',
        body: JSON.stringify(args),
      }),
    releaseHold: (holdId) => request<void>(`/v1/holds/${holdId}`, { method: 'DELETE' }),
    book: (args) =>
      request<BookingResponse | DryRunResponse>(
        '/v1/bookings',
        { method: 'POST', body: JSON.stringify(args) },
        args.idempotencyKey,
      ),
    openapi: () => request<Record<string, unknown>>('/v1/openapi.json'),
  };
}
