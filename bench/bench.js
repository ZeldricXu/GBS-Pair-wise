#!/usr/bin/env node
// 压测 + 正确性校验：
//   1) 组织层天花板：多项目多 key 并发，放行数不超组织配额
//   2) 单机 QPS 基准（对比放行数与固定窗口理论值）
//   3) 批量原子性：一批全放或全不放，被拒不消耗任何配额
//   4) 并发上限：占用-归还，漏归还被 TTL 自动回收
//   5) 配额热更新即时生效，已消耗不被清零
//
// 用法： node bench/bench.js [baseUrl]
// 不传 baseUrl 时脚本会自动拉起一个干净的服务实例（PORT 默认 8090）。

const { spawn } = require('node:child_process');
const path = require('node:path');

const BASE = process.argv[2] ?? `http://127.0.0.1:${process.env.PORT ?? 8090}`;
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 64);

let serverProc = null;

async function call(method, urlPath, body) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

const post = (urlPath, body) => call('POST', urlPath, body);
const put = (urlPath, body) => call('PUT', urlPath, body);

async function waitReady(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // 服务还没起来
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('服务启动超时');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function alignSecond() {
  // 对齐到下一个整秒边界后再偏移 150ms，给整段流量留出不跨窗口的空间
  await sleep(1000 - (Date.now() % 1000) + 150);
}

async function setupHierarchy() {
  await post('/admin/orgs', {
    id: 'org1',
    limits: { perSecond: 500, perMinute: 100000, perHour: 1000000, concurrency: 100000 },
  });
  await post('/admin/projects', {
    id: 'p1', orgId: 'org1',
    limits: { perSecond: 300, perMinute: 100000, perHour: 1000000, concurrency: 100000 },
  });
  await post('/admin/projects', {
    id: 'p2', orgId: 'org1',
    limits: { perSecond: 300, perMinute: 100000, perHour: 1000000, concurrency: 100000 },
  });
  await post('/admin/keys', {
    id: 'k1', projectId: 'p1',
    limits: { perSecond: 100000, perMinute: 100000, perHour: 1000000, concurrency: 100000 },
  });
  await post('/admin/keys', {
    id: 'k2', projectId: 'p2',
    limits: { perSecond: 100000, perMinute: 100000, perHour: 1000000, concurrency: 100000 },
  });
}

// 按 total 个批次、durationMs 时长均匀打流量
async function hammer({ total, durationMs, makeItems, releaseAll = false, ttlMs = 5000 }) {
  let cursor = 0;
  let allowed = 0;
  let denied = 0;
  const leases = [];
  const start = Date.now();

  async function worker() {
    for (;;) {
      const seq = cursor++;
      if (seq >= total) break;
      if (durationMs > 0) {
        const wait = start + (seq / total) * durationMs - Date.now();
        if (wait > 0) await sleep(wait);
      }
      const { json } = await post('/v1/acquire', { items: makeItems(seq), ttlMs });
      if (json.allowed) {
        allowed += json.leaseIds.length;
        if (releaseAll) leases.push(...json.leaseIds);
      } else {
        denied += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (releaseAll) {
    for (let i = 0; i < leases.length; i += 500) {
      await post('/v1/release', { leaseIds: leases.slice(i, i + 500) });
    }
  }
  return { allowed, denied, batches: total, elapsedMs: Date.now() - start };
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function test1_orgCeiling() {
  // key 层很宽，项目层各 300，组织层 500 才是天花板；
  // 同一窗口内全速突发 1000 批（k1/k2 交替），必须恰好放行 500
  await alignSecond();
  const r = await hammer({
    total: 1000,
    durationMs: 0,
    makeItems: (seq) => [{ keyId: seq % 2 === 0 ? 'k1' : 'k2' }],
    ttlMs: 5000,
  });
  const { json: status } = await call('GET', '/admin/status');
  const p1 = status.projects.find((p) => p.id === 'p1');
  const p2 = status.projects.find((p) => p.id === 'p2');
  const org = status.orgs.find((o) => o.id === 'org1');
  check(
    '组织层天花板：多项目并发放行恰好 500，不超卖也不少卖',
    r.allowed === 500 && r.denied === 500 && org.used.perSecond === 500,
    `allowed=${r.allowed}, deniedBatches=${r.denied}, org.used=${org.used.perSecond}, elapsed=${r.elapsedMs}ms`,
  );
  check(
    '下层项目各自不超过 300，总量不超组织',
    p1.used.perSecond <= 300 && p2.used.perSecond <= 300 &&
      p1.used.perSecond + p2.used.perSecond === 500,
    `p1=${p1.used.perSecond}, p2=${p2.used.perSecond}`,
  );
  await sleep(1100);
}

async function test2_qpsBench() {
  // 纯性能基准：把三层每秒限额都放开，5000 个请求压 1 秒，测服务自身吞吐
  await put('/admin/orgs/org1/limits', { perSecond: 100000 });
  await put('/admin/projects/p1/limits', { perSecond: 100000 });
  await put('/admin/keys/k1/limits', { perSecond: 100000 });
  await alignSecond();
  const r = await hammer({
    total: 5000,
    durationMs: 800,
    makeItems: () => [{ keyId: 'k1' }],
    releaseAll: true,
  });
  const processed = r.allowed + r.denied;
  const qps = Math.round((processed / r.elapsedMs) * 1000);
  check(
    '单机 QPS 基准 >= 2000',
    qps >= 2000 && r.allowed === 5000,
    `allowed=${r.allowed}/${processed}, elapsed=${r.elapsedMs}ms, qps≈${qps}, workers=${CONCURRENCY}`,
  );
  await put('/admin/orgs/org1/limits', { perSecond: 500 });
  await put('/admin/projects/p1/limits', { perSecond: 300 });
  await put('/admin/keys/k1/limits', { perSecond: 100000 });
  await sleep(1100);
}

async function test3_batchAtomic() {
  // k1 每秒只有 100，k2 很宽；整批 [k1,k2] 必须同生共死
  await put('/admin/keys/k1/limits', { perSecond: 100 });
  await put('/admin/keys/k2/limits', { perSecond: 100000 });
  await alignSecond();

  let done = 0;
  let allowedBatches = 0;
  let atomic = true;
  await Promise.all(
    Array.from({ length: 32 }, async () => {
      while (done < 400) {
        const seq = done++;
        if (seq >= 400) break;
        const { json } = await post('/v1/acquire', {
          items: [{ keyId: 'k1' }, { keyId: 'k2' }],
          ttlMs: 5000,
        });
        if (json.allowed) {
          allowedBatches += 1;
          if (json.leaseIds.length !== 2) atomic = false;
          await post('/v1/release', { leaseIds: json.leaseIds });
        } else if (json.leaseIds) {
          atomic = false;
        }
      }
    }),
  );
  check(
    '批量原子性：成功批次 <= 100，每批恰好 2 个租约',
    allowedBatches <= 100 && atomic,
    `allowedBatches=${allowedBatches}`,
  );

  // 被拒批次不消耗下层：k2 的秒用量必须恰好等于成功批次数
  const { json: status } = await call('GET', '/admin/status');
  const k2 = status.keys.find((k) => k.id === 'k2');
  check(
    '被拒不消耗任何配额：k2 秒用量 == 成功批次数',
    k2.used.perSecond === allowedBatches,
    `k2.used.perSecond=${k2.used.perSecond}, allowedBatches=${allowedBatches}`,
  );

  await put('/admin/keys/k1/limits', { perSecond: 100000 });
  await sleep(1100);
}

async function test4_concurrencyAndTtl() {
  await put('/admin/keys/k1/limits', { perSecond: 100000, concurrency: 50 });
  await sleep(1050);

  const r = await hammer({
    total: 200, durationMs: 0,
    makeItems: () => [{ keyId: 'k1' }], ttlMs: 2000,
  });
  check('并发上限 50：只放行 50，其余拒绝', r.allowed === 50, `allowed=${r.allowed}`);

  const r2 = await hammer({
    total: 50, durationMs: 0,
    makeItems: () => [{ keyId: 'k1' }], ttlMs: 2000,
  });
  check('未归还且未到期：继续全部拒绝', r2.allowed === 0, `allowed=${r2.allowed}`);

  // TTL 2s + 扫描间隔余量
  await sleep(2700);
  const r3 = await hammer({
    total: 50, durationMs: 0,
    makeItems: () => [{ keyId: 'k1' }], releaseAll: true, ttlMs: 2000,
  });
  check('漏归还被 TTL 自动回收：到期后可重新拿到 50', r3.allowed === 50, `allowed=${r3.allowed}`);

  const r4 = await hammer({
    total: 50, durationMs: 0,
    makeItems: () => [{ keyId: 'k1' }], releaseAll: true, ttlMs: 5000,
  });
  check('显式归还后立即恢复 50', r4.allowed === 50, `allowed=${r4.allowed}`);

  await put('/admin/keys/k1/limits', { concurrency: 100000 });
  await sleep(1100);
}

async function test5_hotUpdate() {
  await put('/admin/keys/k2/limits', { perSecond: 100000 });
  await alignSecond();
  const pre = await hammer({
    total: 30, durationMs: 0,
    makeItems: () => [{ keyId: 'k2' }], releaseAll: true,
  });

  // 同一秒内热改成 50：已消耗的 30 笔仍在，本秒最多还能放 20
  await put('/admin/keys/k2/limits', { perSecond: 50 });
  const after = await hammer({
    total: 100, durationMs: 0,
    makeItems: () => [{ keyId: 'k2' }], releaseAll: true,
  });
  check(
    '热更新即时生效且已消耗不被清零：30 + 20 == 50',
    pre.allowed === 30 && after.allowed === 20,
    `pre=${pre.allowed}, after=${after.allowed}`,
  );

  await put('/admin/keys/k2/limits', { perSecond: 100000 });
  await sleep(1100);
  const recovered = await hammer({
    total: 100, durationMs: 0,
    makeItems: () => [{ keyId: 'k2' }], releaseAll: true,
  });
  check('新窗口自动恢复满额', recovered.allowed === 100, `allowed=${recovered.allowed}`);
}

async function main() {
  if (!process.argv[2]) {
    serverProc = spawn(process.execPath, [path.resolve(__dirname, '..', 'src', 'server.js')], {
      env: {
        ...process.env,
        PORT: String(process.env.PORT ?? 8090),
        SEED_FILE: path.resolve(__dirname, 'empty-seed.json'),
        DEFAULT_LEASE_TTL_MS: '30000',
        SWEEP_INTERVAL_MS: '500',
        LOG_LEVEL: 'silent',
      },
      stdio: 'ignore',
    });
  }

  try {
    await waitReady();
    await setupHierarchy();

    await test1_orgCeiling();
    await test2_qpsBench();
    await test3_batchAtomic();
    await test4_concurrencyAndTtl();
    await test5_hotUpdate();
  } finally {
    if (serverProc) serverProc.kill('SIGTERM');
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  if (serverProc) serverProc.kill('SIGTERM');
  process.exit(1);
});
