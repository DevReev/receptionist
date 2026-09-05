/** Published contract. Other projects integrate from this, never server code. */

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description: string };
  paths: Record<string, unknown>;
  components: Record<string, unknown>;
}

export const openapiDocument: OpenApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Picktime Tool API',
    version: '0.1.0',
    description:
      'Callable tools over the clinic Picktime page: directory, slots, holds, bookings, health. Times are ISO local with an explicit timezone; page internals never appear.',
  },
  paths: {
    '/health': {
      get: {
        summary: 'Deep liveness: browser plus page reachability.',
        security: [],
        responses: {
          '200': { description: 'ok' },
          '503': { description: 'degraded' },
        },
      },
    },
    '/v1/meta': {
      get: {
        summary: 'Directory of services, doctors, and location with stable IDs.',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'directory with timezone and fetch time' },
          '502': { description: 'page-down' },
        },
      },
    },
    '/v1/slots': {
      get: {
        summary: 'Slot listing over a date window. Past times omitted; empty carries none-available.',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'serviceId', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'doctorId', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'from', in: 'query', required: true, schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
          { name: 'to', in: 'query', required: true, schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
        ],
        responses: {
          '200': { description: 'slots with timezone; reason none-available when empty' },
          '404': { description: 'unknown-service or unknown-doctor' },
          '422': { description: 'validation' },
          '429': { description: 'pool-full with Retry-After' },
          '502': { description: 'page-down' },
        },
      },
    },
    '/v1/holds': {
      post: {
        summary: 'Hold a live slot. Server heartbeats; expiry auto-releases.',
        security: [{ bearerAuth: [] }],
        responses: {
          '201': { description: 'hold with expiry' },
          '422': { description: 'invented-slot, slot-taken, or validation' },
          '429': { description: 'pool-full with Retry-After' },
          '502': { description: 'page-down' },
        },
      },
    },
    '/v1/holds/{id}': {
      delete: {
        summary: 'Release a hold explicitly.',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '204': { description: 'released' },
          '404': { description: 'unknown-hold' },
        },
      },
    },
    '/v1/bookings': {
      post: {
        summary: 'Dry run (hold+release, never save) or confirm (hold+heartbeat+save). Phone always required.',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'dry run result; held true, saved false' },
          '201': { description: 'confirmed booking' },
          '404': { description: 'unknown service/doctor/hold' },
          '409': { description: 'idempotency-key conflict' },
          '422': { description: 'invented-slot, slot-taken, pick-a-doctor, or validation' },
          '429': { description: 'pool-full with Retry-After' },
          '502': { description: 'page-down' },
        },
      },
    },
    '/v1/openapi.json': {
      get: {
        summary: 'This document.',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'OpenAPI document' },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
    },
    schemas: {
      Slot: {
        type: 'object',
        required: ['serviceId', 'doctorId', 'start'],
        properties: {
          serviceId: { type: 'string' },
          doctorId: { type: 'string' },
          start: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:00$' },
        },
      },
      Hold: {
        type: 'object',
        required: ['holdId', 'serviceId', 'doctorId', 'slotStart', 'expiresAt'],
        properties: {
          holdId: { type: 'string' },
          serviceId: { type: 'string' },
          doctorId: { type: 'string' },
          slotStart: { type: 'string' },
          expiresAt: { type: 'string' },
        },
      },
      Booking: {
        type: 'object',
        required: ['bookingId', 'serviceId', 'doctorId', 'slotStart'],
        properties: {
          bookingId: { type: 'string' },
          serviceId: { type: 'string' },
          doctorId: { type: 'string' },
          slotStart: { type: 'string' },
        },
      },
    },
  },
};
