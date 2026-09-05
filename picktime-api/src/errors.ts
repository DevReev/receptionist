/** Caller-observable error taxonomy. Never exposes page internals. */
export type ErrorCode =
  | 'validation'
  | 'unknown-service'
  | 'unknown-doctor'
  | 'unknown-hold'
  | 'invented-slot'
  | 'slot-taken'
  | 'save-failed'
  | 'pick-a-doctor'
  | 'conflict'
  | 'pool-full'
  | 'page-down';
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function validation(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(422, 'validation', message, details);
}

export function unknownService(id: string): ApiError {
  return new ApiError(404, 'unknown-service', `unknown service: ${id}`);
}

export function unknownDoctor(id: string): ApiError {
  return new ApiError(404, 'unknown-doctor', `unknown doctor: ${id}`);
}

export function unknownHold(id: string): ApiError {
  return new ApiError(404, 'unknown-hold', `unknown hold: ${id}`);
}

export function inventedSlot(slotStart: string): ApiError {
  return new ApiError(422, 'invented-slot', `slot is not in live availability: ${slotStart}`);
}

export function slotTaken(slotStart: string): ApiError {
  return new ApiError(422, 'slot-taken', `slot is already held or booked: ${slotStart}`);
}

export function saveFailed(slotStart: string, reason: string): ApiError {
  return new ApiError(422, 'save-failed', `booking save rejected for ${slotStart}: ${reason}`);
}

export function pickADoctor(candidates: Array<{ id: string; name: string }>): ApiError {
  return new ApiError(422, 'pick-a-doctor', 'multiple doctors available; pick one', {
    candidates,
  });
}

export function conflict(message: string): ApiError {
  return new ApiError(409, 'conflict', message);
}

export function poolFull(): ApiError {
  return new ApiError(429, 'pool-full', 'browser pool exhausted; retry shortly');
}

export function pageDown(reason: string): ApiError {
  return new ApiError(502, 'page-down', `booking page unavailable: ${reason}`);
}
