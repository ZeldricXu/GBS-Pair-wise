import test from 'node:test';
import assert from 'node:assert/strict';
import { QuotaEngine } from '../src/quota-engine.js';

function createEngine() {
  const engine = new QuotaEngine({ reaperIntervalMs: 0 });
  engine.loadConfig({
    quotas: {
      orgs: {
        org: { perSecond: 10, perMinute: null, perHour: null, concurrency: 10 },
        blockedOrg: { perSecond: 0, perMinute: null, perHour: null, concurrency: null },
      },
      projects: {
        org: {
          project: { perSecond: 10, perMinute: null, perHour: null, concurrency: 10 },
          lowProject: { perSecond: 1, perMinute: null, perHour: null, concurrency: null },
        },
      },
      keys: {
        key1: { perSecond: 10, perMinute: null, perHour: null, concurrency: 1 },
        key2: { perSecond: 10, perMinute: null, perHour: null, concurrency: 1 },
      },
    },
  });
  return engine;
}

test('accepts and explicitly releases a lease', () => {
  const engine = createEngine();
  const result = engine.acquire({ orgId: 'org', projectId: 'project', keyId: 'key1' });

  assert.equal(result.allowed, true);
  assert.equal(result.lease.permits, 1);
  assert.equal(engine.release(result.lease.id).released, true);
  engine.close();
});

test('denies upper layers before consuming lower-layer quota', () => {
  const engine = createEngine();

  const denied = engine.acquire({ orgId: 'blockedOrg', projectId: 'project', keyId: 'key1' });
  assert.equal(denied.allowed, false);
  assert.equal(denied.denied.layer, 'org');

  const allowed = engine.acquire({ orgId: 'org', projectId: 'project', keyId: 'key1' });
  assert.equal(allowed.allowed, true);
  engine.close();
});

test('enforces all three layers and concurrency', () => {
  const engine = createEngine();

  const first = engine.acquire({ orgId: 'org', projectId: 'project', keyId: 'key1' });
  const second = engine.acquire({ orgId: 'org', projectId: 'project', keyId: 'key1' });

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.equal(second.denied.layer, 'key');
  assert.equal(second.denied.reason, 'concurrency_exhausted');

  engine.release(first.lease.id);
  const third = engine.acquire({ orgId: 'org', projectId: 'project', keyId: 'key1' });
  assert.equal(third.allowed, true);
  engine.close();
});

test('batch is atomic when one key cannot be admitted', () => {
  const engine = createEngine();

  const key1Lease = engine.acquire({ orgId: 'org', projectId: 'project', keyId: 'key1' });
  assert.equal(key1Lease.allowed, true);

  const batch = engine.acquireBatch({
    orgId: 'org',
    items: [
      { projectId: 'project', keyId: 'key1' },
      { projectId: 'project', keyId: 'key2' },
    ],
  });

  assert.equal(batch.allowed, false);
  assert.equal(batch.denied.layer, 'key');
  assert.equal(batch.denied.resourceId, 'key1');

  const key2 = engine.acquire({ orgId: 'org', projectId: 'project', keyId: 'key2' });
  assert.equal(key2.allowed, true);
  engine.close();
});

test('releases an unreleased lease after expiry', () => {
  let wallNow = 10_000;
  const engine = new QuotaEngine({
    nowRate: () => 0,
    nowLease: () => wallNow,
    reaperIntervalMs: 0,
  });
  engine.loadConfig({
    quotas: {
      orgs: { org: { concurrency: 1 } },
      projects: { org: { project: { concurrency: null } } },
      keys: { key: { concurrency: 1 } },
    },
  });

  const first = engine.acquire({ orgId: 'org', projectId: 'project', keyId: 'key', leaseTtlMs: 100 });
  assert.equal(first.allowed, true);
  assert.equal(engine.reapExpiredLeases().count, 0);

  wallNow = 10_101;
  assert.equal(engine.reapExpiredLeases().count, 1);

  const second = engine.acquire({ orgId: 'org', projectId: 'project', keyId: 'key', leaseTtlMs: 100 });
  assert.equal(second.allowed, true);
  engine.close();
});

test('dynamic rate decreases preserve recently consumed quota', () => {
  let monoNow = 0;
  const engine = new QuotaEngine({ nowRate: () => monoNow, nowLease: () => 0, reaperIntervalMs: 0 });
  engine.loadConfig({
    quotas: {
      orgs: { org: { perSecond: 10, concurrency: null } },
      projects: { org: { project: { concurrency: null } } },
      keys: { key: { concurrency: null } },
    },
  });

  for (let index = 0; index < 9; index += 1) {
    const result = engine.acquire({ orgId: 'org', projectId: 'project', keyId: 'key' });
    assert.equal(result.allowed, true);
  }

  engine.setProfile('org', 'org', { perSecond: 1 }, { replace: true });
  monoNow = 0;

  const result = engine.acquire({ orgId: 'org', projectId: 'project', keyId: 'key' });
  assert.equal(result.allowed, false);
  assert.equal(result.denied.layer, 'org');

  monoNow = 11_000;
  assert.equal(engine.acquire({ orgId: 'org', projectId: 'project', keyId: 'key' }).allowed, true);
  engine.close();
});

test('dynamic rate increases preserve outstanding permits', () => {
  let monoNow = 0;
  const engine = new QuotaEngine({ nowRate: () => monoNow, nowLease: () => 0, reaperIntervalMs: 0 });
  engine.loadConfig({
    quotas: {
      orgs: { org: { perSecond: 10, concurrency: null } },
      projects: { org: { project: { concurrency: null } } },
      keys: { key: { concurrency: null } },
    },
  });

  for (let index = 0; index < 9; index += 1) {
    assert.equal(engine.acquire({ orgId: 'org', projectId: 'project', keyId: 'key' }).allowed, true);
  }

  engine.setProfile('org', 'org', { perSecond: 500 }, { replace: true });

  for (let index = 0; index < 491; index += 1) {
    assert.equal(engine.acquire({ orgId: 'org', projectId: 'project', keyId: 'key' }).allowed, true);
  }

  const denied = engine.acquire({ orgId: 'org', projectId: 'project', keyId: 'key' });
  assert.equal(denied.allowed, false);
  assert.equal(denied.denied.layer, 'org');
  engine.close();
});

test('heartbeat prevents lease expiry', () => {
  let wallNow = 0;
  const engine = new QuotaEngine({ nowRate: () => 0, nowLease: () => wallNow, reaperIntervalMs: 0 });
  engine.loadConfig({
    quotas: {
      orgs: { org: { concurrency: 1 } },
      projects: { org: { project: { concurrency: null } } },
      keys: { key: { concurrency: 1 } },
    },
  });

  const lease = engine.acquire({ orgId: 'org', projectId: 'project', keyId: 'key', leaseTtlMs: 100 });
  wallNow = 90;
  const renewed = engine.heartbeat(lease.lease.id, 100);
  assert.equal(renewed.renewed, true);

  wallNow = 189;
  assert.equal(engine.reapExpiredLeases().count, 0);

  wallNow = 201;
  assert.equal(engine.reapExpiredLeases().count, 1);
  engine.close();
});

test('rate denial does not consume or mutate quota', () => {
  let rateNow = 0;
  const engine = new QuotaEngine({ nowRate: () => rateNow, nowLease: () => 0, reaperIntervalMs: 0 });
  engine.loadConfig({
    quotas: {
      orgs: { org: { perSecond: 1, concurrency: null } },
      projects: { org: { project: { concurrency: null } } },
      keys: { key: { concurrency: null } },
    },
  });

  assert.equal(engine.acquire({ orgId: 'org', projectId: 'project', keyId: 'key' }).allowed, true);
  assert.equal(engine.acquire({ orgId: 'org', projectId: 'project', keyId: 'key' }).allowed, false);

  rateNow = 1_001;
  assert.equal(engine.acquire({ orgId: 'org', projectId: 'project', keyId: 'key' }).allowed, true);
  engine.close();
});
