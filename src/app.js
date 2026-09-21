import Fastify from 'fastify';
import { QuotaEngine, QuotaError, profileToWire } from './quota-engine.js';

const idPattern = '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$';

const profileSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    perSecond: { type: ['integer', 'null'], minimum: 0 },
    perMinute: { type: ['integer', 'null'], minimum: 0 },
    perHour: { type: ['integer', 'null'], minimum: 0 },
    concurrency: { type: ['integer', 'null'], minimum: 0 },
  },
};

const acquireSchema = {
  type: 'object',
  required: ['orgId', 'projectId', 'keyId'],
  additionalProperties: false,
  properties: {
    orgId: { type: 'string', pattern: idPattern },
    projectId: { type: 'string', pattern: idPattern },
    keyId: { type: 'string', pattern: idPattern },
    amount: { type: 'integer', minimum: 1 },
    leaseTtlMs: { type: 'integer', minimum: 1, maximum: 3_600_000 },
  },
};

const batchItemSchema = {
  type: 'object',
  required: ['projectId', 'keyId'],
  additionalProperties: false,
  properties: {
    projectId: { type: 'string', pattern: idPattern },
    keyId: { type: 'string', pattern: idPattern },
    amount: { type: 'integer', minimum: 1 },
  },
};

const batchSchema = {
  type: 'object',
  required: ['orgId', 'items'],
  additionalProperties: false,
  properties: {
    orgId: { type: 'string', pattern: idPattern },
    leaseTtlMs: { type: 'integer', minimum: 1, maximum: 3_600_000 },
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 1_000,
      items: batchItemSchema,
    },
  },
};

const releaseSchema = {
  type: 'object',
  required: ['leaseId'],
  additionalProperties: false,
  properties: {
    leaseId: { type: 'string', minLength: 8, maxLength: 128 },
  },
};

const heartbeatSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ttlMs: { type: 'integer', minimum: 1, maximum: 3_600_000 },
  },
};

export function buildApp({ engine = new QuotaEngine(), logger = false } = {}) {
  const app = Fastify({ logger, trustProxy: false });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof QuotaError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
    }

    if (error.validation) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: error.message,
          details: { issues: error.validation },
        },
      });
    }

    request.log.error(error);
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Internal quota service error' },
    });
  });

  app.get('/health', async () => ({ ok: true, service: 'quota-service' }));

  app.post('/v1/acquire', { schema: { body: acquireSchema } }, async (request) => engine.acquire(request.body));

  app.post('/v1/acquire-batch', { schema: { body: batchSchema } }, async (request) =>
    engine.acquireBatch(request.body),
  );

  app.post('/v1/releases', { schema: { body: releaseSchema } }, async (request) =>
    engine.release(request.body.leaseId),
  );

  app.post('/v1/leases/:leaseId/heartbeat', { schema: { body: heartbeatSchema } }, async (request) =>
    engine.heartbeat(request.params.leaseId, request.body.ttlMs),
  );

  app.get('/v1/quotas', async () => ({ quotas: engine.listProfiles() }));

  app.put('/v1/quotas/orgs/:orgId', { schema: { body: profileSchema } }, async (request) => {
    const profile = engine.setProfile('org', request.params.orgId, request.body ?? {}, { replace: true });
    return { orgId: request.params.orgId, quota: profileToWire(profile) };
  });

  app.patch('/v1/quotas/orgs/:orgId', { schema: { body: profileSchema } }, async (request) => {
    const profile = engine.setProfile('org', request.params.orgId, request.body ?? {}, { replace: false });
    return { orgId: request.params.orgId, quota: profileToWire(profile) };
  });

  app.put('/v1/quotas/orgs/:orgId/projects/:projectId', { schema: { body: profileSchema } }, async (request) => {
    const identity = { orgId: request.params.orgId, projectId: request.params.projectId };
    const profile = engine.setProfile('project', identity, request.body ?? {}, { replace: true });
    return { ...identity, quota: profileToWire(profile) };
  });

  app.patch('/v1/quotas/orgs/:orgId/projects/:projectId', { schema: { body: profileSchema } }, async (request) => {
    const identity = { orgId: request.params.orgId, projectId: request.params.projectId };
    const profile = engine.setProfile('project', identity, request.body ?? {}, { replace: false });
    return { ...identity, quota: profileToWire(profile) };
  });

  app.put('/v1/quotas/keys/:keyId', { schema: { body: profileSchema } }, async (request) => {
    const profile = engine.setProfile('key', request.params.keyId, request.body ?? {}, { replace: true });
    return { keyId: request.params.keyId, quota: profileToWire(profile) };
  });

  app.patch('/v1/quotas/keys/:keyId', { schema: { body: profileSchema } }, async (request) => {
    const profile = engine.setProfile('key', request.params.keyId, request.body ?? {}, { replace: false });
    return { keyId: request.params.keyId, quota: profileToWire(profile) };
  });

  app.get('/v1/usage', async () => engine.usage());

  app.addHook('onClose', async () => engine.close());

  return app;
}
