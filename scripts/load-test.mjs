import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const durationSeconds = Number.parseFloat(process.env.DURATION_SECONDS ?? '3');
const targetQps = Number.parseInt(process.env.TARGET_QPS ?? '4000', 10);
const limitQps = Number.parseInt(process.env.LIMIT_QPS ?? '2000', 10);
const concurrency = Number.parseInt(process.env.CLIENT_CONCURRENCY ?? '256', 10);
const warmupMs = 700;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitForServer(baseUrl, deadline = Date.now() + 10_000) {
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        const response = await fetch(`${baseUrl}/health`);
        if (response.ok) return resolve();
      } catch {}

      if (Date.now() > deadline) return reject(new Error('Server did not become ready'));
      setTimeout(attempt, 50);
    };
    attempt();
  });
}

async function configure(baseUrl) {
  const profile = {
    perSecond: limitQps,
    perMinute: null,
    perHour: null,
    concurrency: 1_000_000,
  };

  const requests = [
    ['PUT', '/v1/quotas/orgs/load-org', profile],
    ['PUT', '/v1/quotas/orgs/load-org/projects/load-project', { concurrency: 1_000_000 }],
    ['PUT', '/v1/quotas/keys/load-key', { concurrency: 1_000_000 }],
  ];

  for (const [method, path, payload] of requests) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Configuration failed: ${response.status} ${await response.text()}`);
  }
}

async function runTraffic(baseUrl) {
  const start = Date.now();
  const end = start + durationSeconds * 1000;
  let sent = 0;
  let allowed = 0;
  let denied = 0;
  let failed = 0;
  let inflight = 0;
  const acceptedAt = [];

  const sendOne = async () => {
    inflight += 1;
    try {
      const response = await fetch(`${baseUrl}/v1/acquire`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          orgId: 'load-org',
          projectId: 'load-project',
          keyId: 'load-key',
          leaseTtlMs: 60_000,
        }),
      });
      const body = await response.json();
      if (body.allowed) {
        allowed += 1;
        acceptedAt.push(body.acceptedAt);
      } else {
        denied += 1;
      }
    } catch {
      failed += 1;
    } finally {
      inflight -= 1;
    }
  };

  const pump = () => {
    while (true) {
      const now = Date.now();
      const elapsedSeconds = Math.max(0.001, (now - start) / 1000);
      if (now >= end || inflight >= concurrency || sent / elapsedSeconds >= targetQps * 1.05) break;
      sent += 1;
      sendOne();
    }
  };

  const interval = setInterval(pump, 5);
  pump();

  await new Promise((resolve) => setTimeout(resolve, durationSeconds * 1000 + warmupMs));
  clearInterval(interval);

  while (sent !== allowed + denied + failed) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  clearInterval(interval);

  return { sent, allowed, denied, failed, acceptedAt, elapsedMs: end - start, start, end };
}

function analyze(acceptedAt, start, end) {
  const times = acceptedAt.sort((a, b) => a - b);
  const steady = times.filter((time) => time >= start + 1_000 && time < end);
  let maxInOneSecond = 0;

  for (let windowStart = start + 1_000; windowStart + 1_000 <= end; windowStart += 100) {
    const count = steady.filter((time) => time >= windowStart && time < windowStart + 1_000).length;
    maxInOneSecond = Math.max(maxInOneSecond, count);
  }

  const measuredMs = Math.max(1, end - start - 1_000);
  return {
    maxInOneSecond,
    measuredDurationSeconds: measuredMs / 1000,
    steadyStateAllowed: steady.length / (measuredMs / 1000),
  };
}

async function main() {
  const port = await getFreePort();
  const configDir = await mkdtemp(join(tmpdir(), 'quota-load-'));
  const configPath = join(configDir, 'quotas.json');
  await writeFile(configPath, JSON.stringify({ quotas: {} }));

  const child = spawn(process.execPath, [join(root, 'src', 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      QUOTA_CONFIG: configPath,
      LOGGER: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverOutput = '';
  child.stdout.on('data', (chunk) => {
    serverOutput += chunk;
  });
  child.stderr.on('data', (chunk) => {
    serverOutput += chunk;
  });

  try {
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) console.error(`Server exited with ${code}\n${serverOutput}`);
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForServer(baseUrl);
    await configure(baseUrl);

    const result = await runTraffic(baseUrl);
    const analysis = analyze(result.acceptedAt, result.start, result.end);
    const attemptedQps = result.sent / (result.elapsedMs / 1000);

    console.table({
      sent: result.sent,
      allowed: result.allowed,
      denied: result.denied,
      failed: result.failed,
      attemptedQps: Math.round(attemptedQps),
      maxAcceptedInRollingSecond: analysis.maxInOneSecond,
      steadyAcceptedQps: Math.round(analysis.steadyStateAllowed),
    });

    if (result.failed > 0) throw new Error(`${result.failed} requests failed`);
    if (analysis.maxInOneSecond > limitQps) {
      throw new Error(`Oversell detected: ${analysis.maxInOneSecond} > ${limitQps} in one rolling second`);
    }
    if (attemptedQps < targetQps * 0.9) {
      throw new Error(`Client could not generate target load: ${Math.round(attemptedQps)} < ${targetQps}`);
    }
    if (analysis.steadyStateAllowed < limitQps * 0.95) {
      throw new Error(`Under-admission too high: ${Math.round(analysis.steadyStateAllowed)} < ${limitQps * 0.95}`);
    }

    console.log('Load test passed without rolling-window oversell.');
  } finally {
    child.kill('SIGTERM');
    await rm(configDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
