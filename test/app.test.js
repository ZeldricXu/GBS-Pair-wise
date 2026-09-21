import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';

async function withApp(run) {
  const app = buildApp();
  await app.ready();
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

test('creates quota, acquires a lease, and releases it over HTTP', async () => {
  await withApp(async (app) => {
    const profile = { perSecond: 1, perMinute: null, perHour: null, concurrency: 1 };

    const orgResponse = await app.inject({
      method: 'PUT',
      url: '/v1/quotas/orgs/org',
      payload: profile,
    });
    assert.equal(orgResponse.statusCode, 200);

    const projectResponse = await app.inject({
      method: 'PUT',
      url: '/v1/quotas/orgs/org/projects/project',
      payload: { concurrency: 1 },
    });
    assert.equal(projectResponse.statusCode, 200);

    const keyResponse = await app.inject({
      method: 'PUT',
      url: '/v1/quotas/keys/key',
      payload: profile,
    });
    assert.equal(keyResponse.statusCode, 200);

    const acquireResponse = await app.inject({
      method: 'POST',
      url: '/v1/acquire',
      payload: { orgId: 'org', projectId: 'project', keyId: 'key', leaseTtlMs: 1000 },
    });
    assert.equal(acquireResponse.statusCode, 200);
    const acquireBody = acquireResponse.json();
    assert.equal(acquireBody.allowed, true);

    const releaseResponse = await app.inject({
      method: 'POST',
      url: '/v1/releases',
      payload: { leaseId: acquireBody.lease.id },
    });
    assert.equal(releaseResponse.statusCode, 200);
    assert.equal(releaseResponse.json().released, true);
  });
});

test('supports all-or-nothing batch acquisition', async () => {
  await withApp(async (app) => {
    await app.inject({ method: 'PUT', url: '/v1/quotas/orgs/org', payload: { concurrency: 10 } });
    await app.inject({
      method: 'PUT',
      url: '/v1/quotas/orgs/org/projects/project',
      payload: { concurrency: 10 },
    });
    await app.inject({ method: 'PUT', url: '/v1/quotas/keys/key1', payload: { concurrency: 1 } });
    await app.inject({ method: 'PUT', url: '/v1/quotas/keys/key2', payload: { concurrency: 1 } });

    const first = await app.inject({
      method: 'POST',
      url: '/v1/acquire',
      payload: { orgId: 'org', projectId: 'project', keyId: 'key1' },
    });
    assert.equal(first.json().allowed, true);

    const batch = await app.inject({
      method: 'POST',
      url: '/v1/acquire-batch',
      payload: {
        orgId: 'org',
        items: [
          { projectId: 'project', keyId: 'key1' },
          { projectId: 'project', keyId: 'key2' },
        ],
      },
    });

    assert.equal(batch.statusCode, 200);
    assert.equal(batch.json().allowed, false);

    const key2 = await app.inject({
      method: 'POST',
      url: '/v1/acquire',
      payload: { orgId: 'org', projectId: 'project', keyId: 'key2' },
    });
    assert.equal(key2.json().allowed, true);
  });
});

test('applies quota updates immediately', async () => {
  await withApp(async (app) => {
    await app.inject({ method: 'PUT', url: '/v1/quotas/orgs/org', payload: { perSecond: 100 } });
    await app.inject({
      method: 'PUT',
      url: '/v1/quotas/orgs/org/projects/project',
      payload: {},
    });
    await app.inject({ method: 'PUT', url: '/v1/quotas/keys/key', payload: {} });

    const updated = await app.inject({
      method: 'PATCH',
      url: '/v1/quotas/orgs/org',
      payload: { perSecond: 0 },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().quota.perSecond, 0);

    const denied = await app.inject({
      method: 'POST',
      url: '/v1/acquire',
      payload: { orgId: 'org', projectId: 'project', keyId: 'key' },
    });
    assert.equal(denied.statusCode, 200);
    assert.equal(denied.json().allowed, false);
    assert.equal(denied.json().denied.reason, 'rate_limited');
  });
});

test('returns structured validation errors', async () => {
  await withApp(async (app) => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/acquire',
      payload: { orgId: '', projectId: 'project' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'VALIDATION_ERROR');
  });
});
