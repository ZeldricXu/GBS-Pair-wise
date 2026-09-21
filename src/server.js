import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { QuotaEngine } from './quota-engine.js';

async function loadInitialConfig(configPath) {
  try {
    const source = await readFile(configPath, 'utf8');
    return JSON.parse(source);
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Failed to load quota config ${configPath}: ${error.message}`);
  }
}

async function start() {
  const host = process.env.HOST ?? '0.0.0.0';
  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  const configPath = resolve(process.cwd(), process.env.QUOTA_CONFIG ?? 'config/quotas.json');
  const config = await loadInitialConfig(configPath);
  const engine = new QuotaEngine({ reaperIntervalMs: Number(process.env.REAPER_INTERVAL_MS ?? 250) });
  engine.loadConfig(config);

  const app = buildApp({ engine, logger: process.env.LOGGER === 'true' });

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  await app.listen({ host, port });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
