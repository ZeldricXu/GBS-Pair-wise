const path = require('node:path');
const fs = require('node:fs');
const Fastify = require('fastify');
const { QuotaEngine, EngineError } = require('./engine');

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const SEED_FILE = process.env.SEED_FILE
  ? path.resolve(process.env.SEED_FILE)
  : path.resolve(__dirname, '..', 'seed.json');

const engine = new QuotaEngine({
  defaultLeaseTtlMs: Number(process.env.DEFAULT_LEASE_TTL_MS ?? 30_000),
  maxLeaseTtlMs: Number(process.env.MAX_LEASE_TTL_MS ?? 300_000),
  sweepIntervalMs: Number(process.env.SWEEP_INTERVAL_MS ?? 1_000),
});

function loadSeed(file) {
  if (!fs.existsSync(file)) return;
  const seed = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const org of seed.orgs ?? []) engine.upsertOrg(org);
  for (const project of seed.projects ?? []) engine.upsertProject(project);
  for (const key of seed.keys ?? []) engine.upsertKey(key);
}

loadSeed(SEED_FILE);
engine.start();

const fastify = Fastify({
  // 数据面高 QPS，默认关掉请求日志避免 stdout 成为瓶颈；LOG_LEVEL != silent 时开 logger
  logger:
    (process.env.LOG_LEVEL ?? 'warn') === 'silent'
      ? false
      : { level: process.env.LOG_LEVEL ?? 'warn' },
  bodyLimit: 1024 * 1024,
});

fastify.setErrorHandler((error, request, reply) => {
  if (error instanceof EngineError) {
    return reply.code(400).send({ ok: false, error: { code: error.code, message: error.message } });
  }
  if (error.validation) {
    return reply
      .code(400)
      .send({ ok: false, error: { code: 'invalid_request', message: error.message } });
  }
  request.log.error(error);
  reply.code(500).send({ ok: false, error: { code: 'internal_error', message: '内部错误' } });
});

const limitSchemaProps = {
  perSecond: { type: ['integer', 'null'], minimum: 0 },
  perMinute: { type: ['integer', 'null'], minimum: 0 },
  perHour: { type: ['integer', 'null'], minimum: 0 },
  concurrency: { type: ['integer', 'null'], minimum: 0 },
};

const limitsObject = {
  type: 'object',
  properties: limitSchemaProps,
  additionalProperties: false,
};

fastify.get('/health', async () => ({ ok: true }));

// ---- 管理面 ----

fastify.post(
  '/admin/orgs',
  {
    schema: {
      body: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', minLength: 1 }, limits: limitsObject },
        additionalProperties: false,
      },
    },
  },
  async (request) => {
    engine.upsertOrg(request.body);
    return { ok: true };
  },
);

fastify.post(
  '/admin/projects',
  {
    schema: {
      body: {
        type: 'object',
        required: ['id', 'orgId'],
        properties: {
          id: { type: 'string', minLength: 1 },
          orgId: { type: 'string', minLength: 1 },
          limits: limitsObject,
        },
        additionalProperties: false,
      },
    },
  },
  async (request) => {
    engine.upsertProject(request.body);
    return { ok: true };
  },
);

fastify.post(
  '/admin/keys',
  {
    schema: {
      body: {
        type: 'object',
        required: ['id', 'projectId'],
        properties: {
          id: { type: 'string', minLength: 1 },
          projectId: { type: 'string', minLength: 1 },
          limits: limitsObject,
        },
        additionalProperties: false,
      },
    },
  },
  async (request) => {
    engine.upsertKey(request.body);
    return { ok: true };
  },
);

// 配额热更新：只改限额，窗口已消耗量与在途占位保持不动
for (const [type, pathName] of [
  ['org', 'orgs'],
  ['project', 'projects'],
  ['key', 'keys'],
]) {
  fastify.put(
    `/admin/${pathName}/:id/limits`,
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        body: { type: 'object', properties: limitSchemaProps, additionalProperties: false },
      },
    },
    async (request) => {
      engine.updateLimits(type, request.params.id, request.body);
      return { ok: true };
    },
  );
}

fastify.get('/admin/status', async () => ({ ok: true, ...engine.status() }));

// ---- 数据面：业务方问“这次请求放不放行” ----

fastify.post(
  '/v1/acquire',
  {
    schema: {
      body: {
        type: 'object',
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            maxItems: 1000,
            items: {
              type: 'object',
              required: ['keyId'],
              properties: {
                keyId: { type: 'string', minLength: 1 },
                orgId: { type: 'string' },
                projectId: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
          ttlMs: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
      },
    },
  },
  async (request) => {
    const { items, ttlMs } = request.body;
    const result = engine.acquire(items, ttlMs ? { ttlMs } : {});
    if (!result.allowed) {
      return { allowed: false, denied: true, reason: result.reason };
    }
    return {
      allowed: true,
      leaseIds: result.leaseIds,
      expiresAt: result.expiresAt,
      ttlMs: result.ttlMs,
    };
  },
);

fastify.post(
  '/v1/release',
  {
    schema: {
      body: {
        type: 'object',
        required: ['leaseIds'],
        properties: {
          leaseIds: {
            type: 'array',
            maxItems: 1000,
            items: { type: 'string', minLength: 1 },
          },
        },
        additionalProperties: false,
      },
    },
  },
  async (request) => {
    return engine.release(request.body.leaseIds);
  },
);

async function start() {
  try {
    await fastify.listen({ port: PORT, host: HOST });
    fastify.log.info(`quota service listening on http://${HOST}:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

async function shutdown() {
  await fastify.close();
  engine.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (require.main === module) {
  start();
}

module.exports = { fastify, engine };
