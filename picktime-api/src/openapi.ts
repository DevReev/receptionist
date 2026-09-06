/** Published contract. The public API has no authentication; callers must use stable IDs and idempotency keys. */

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description: string };
  paths: Record<string, unknown>;
  components: Record<string, unknown>;
}

const slotOperation = {
  get: {
    summary: 'Return live available slots over a date window. Location is optional for discovery.',
    security: [],
    parameters: [
      { name: 'serviceId', in: 'query', required: true, schema: { type: 'string' } },
      { name: 'doctorId', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'locationId', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'from', in: 'query', required: true, schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
      { name: 'to', in: 'query', required: true, schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
      { name: 'startDate', in: 'query', required: false, description: 'Compatibility alias for from when a tool platform reserves the name from.', schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
      { name: 'endDate', in: 'query', required: false, description: 'Compatibility alias for to when a tool platform reserves the name to.', schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
    ],
    responses: {
      '200': { description: 'Live slots with timezone and fetch time; empty results carry none-available.' },
      '404': { description: 'unknown-service, unknown-doctor, or unknown-location' },
      '413': { description: 'request-too-large' },
      '422': { description: 'validation' },
      '429': { description: 'rate-limit or pool-full with Retry-After' },
      '502': { description: 'page-down' },
    },
  },
};

const bookingOperation = {
  post: {
    summary: 'Create a booking after a live hold. Location and patient identity are required.',
    security: [],
    parameters: [
      {
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
        description: 'Required for real bookings; optional for dryRun. Reusing it with a different payload returns 409.',
        schema: { type: 'string', minLength: 1, maxLength: 200 },
      },
    ],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/BookAppointmentRequest' },
        },
      },
    },
    responses: {
      '201': { description: 'Confirmed booking.' },
      '404': { description: 'unknown-service, unknown-doctor, unknown-location, or unknown-hold' },
      '409': { description: 'idempotency-key conflict' },
      '413': { description: 'request-too-large' },
      '422': { description: 'validation, invented-slot, slot-taken, or pick-a-doctor' },
      '429': { description: 'rate-limit or pool-full with Retry-After' },
      '502': { description: 'page-down or save-failed' },
    },
  },
};

export const openapiDocument: OpenApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Picktime Booking API',
    version: '0.2.0',
    description:
      'Public callable endpoints for live Picktime availability and bookings. Times are ISO local with an explicit timezone; service, doctor, and location IDs come from the live directory.',
  },
  paths: {
    '/health': {
      get: {
        summary: 'Deep liveness: browser plus Picktime page reachability.',
        security: [],
        responses: {
          '200': { description: 'ok' },
          '503': { description: 'degraded' },
        },
      },
    },
    '/v1/meta': {
      get: {
        summary: 'Live directory of services, doctors, and locations with stable IDs.',
        security: [],
        responses: {
          '200': { description: 'directory with timezone and fetch time' },
          '429': { description: 'rate-limit or pool-full with Retry-After' },
          '502': { description: 'page-down' },
        },
      },
    },
    '/v1/get_available_slots': slotOperation,
    '/v1/slots': slotOperation,
    '/v1/book_appointment': bookingOperation,
    '/v1/bookings': bookingOperation,
    '/v1/holds': {
      post: {
        summary: 'Hold a live slot at a location. Server heartbeats; expiry auto-releases.',
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/HoldRequest' } } },
        },
        responses: {
          '201': { description: 'hold with expiry' },
          '413': { description: 'request-too-large' },
          '422': { description: 'invented-slot, slot-taken, or validation' },
          '429': { description: 'rate-limit or pool-full with Retry-After' },
          '502': { description: 'page-down' },
        },
      },
    },
    '/v1/holds/{id}': {
      delete: {
        summary: 'Release a hold explicitly.',
        security: [],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '204': { description: 'released' },
          '404': { description: 'unknown-hold' },
          '429': { description: 'rate-limit or pool-full with Retry-After' },
        },
      },
    },
    '/v1/openapi.json': {
      get: {
        summary: 'This document.',
        security: [],
        responses: { '200': { description: 'OpenAPI document' } },
      },
    },
  },
  components: {
    schemas: {
      Slot: {
        type: 'object',
        required: ['serviceId', 'doctorId', 'locationId', 'start'],
        properties: {
          serviceId: { type: 'string' },
          doctorId: { type: 'string' },
          locationId: { type: 'string' },
          start: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:00$' },
        },
      },
      HoldRequest: {
        type: 'object',
        required: ['serviceId', 'locationId', 'slotStart'],
        properties: {
          serviceId: { type: 'string' },
          doctorId: { type: 'string' },
          locationId: { type: 'string' },
          slotStart: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:00$' },
        },
      },
      BookAppointmentRequest: {
        type: 'object',
        required: ['serviceId', 'locationId', 'slotStart', 'patientName', 'patientPhone'],
        properties: {
          serviceId: { type: 'string' },
          doctorId: { type: 'string', description: 'Optional only when the live page has one doctor.' },
          locationId: { type: 'string' },
          slotStart: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:00$' },
          patientName: { type: 'string', minLength: 1, maxLength: 200 },
          patientPhone: { type: 'string', pattern: '^\\+[1-9]\\d{7,14}$' },
          dryRun: { type: 'boolean', description: 'When true, hold and release without saving.' },
        },
      },
      Hold: {
        type: 'object',
        required: ['holdId', 'serviceId', 'doctorId', 'locationId', 'slotStart', 'expiresAt'],
        properties: {
          holdId: { type: 'string' },
          serviceId: { type: 'string' },
          doctorId: { type: 'string' },
          locationId: { type: 'string' },
          slotStart: { type: 'string' },
          expiresAt: { type: 'string' },
        },
      },
      Booking: {
        type: 'object',
        required: ['bookingId', 'serviceId', 'doctorId', 'locationId', 'slotStart', 'timeZone'],
        properties: {
          bookingId: { type: 'string' },
          serviceId: { type: 'string' },
          doctorId: { type: 'string' },
          locationId: { type: 'string' },
          slotStart: { type: 'string' },
          timeZone: { type: 'string' },
        },
      },
    },
  },
};
