// One command for local development without Docker (decision D4): a persistent embedded PostgreSQL in
// .data/dev-pg, dev-only secrets in .data/dev-secrets.json, migrations, test seed, API and jobs.
// npm run dev            start everything (test mode)
// npm run db:up          only the database, for `tsx watch server/src/main.ts` in another terminal
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { DATA_DIR } from '../src/lib/paths.js';
import { loadEnvFile } from '../src/bootstrap.js';

const dbOnly = process.argv.includes('--db-only');
const port = Number(process.env.DEV_PG_PORT ?? 54329);
const pgDir = path.join(DATA_DIR, 'dev-pg');
const password = 'zentrix-dev-only';
mkdirSync(DATA_DIR, { recursive: true });

const secretsFile = path.join(DATA_DIR, 'dev-secrets.json');
if (!existsSync(secretsFile)) {
  writeFileSync(secretsFile, JSON.stringify({ CSRF_SECRET: randomBytes(32).toString('base64url'), DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64') }, null, 2));
}
const secrets = JSON.parse(readFileSync(secretsFile, 'utf8')) as Record<string, string>;

const server = new EmbeddedPostgres({ databaseDir: pgDir, port, user: 'postgres', password, persistent: true, onLog: () => undefined, onError: () => undefined });
if (!existsSync(path.join(pgDir, 'PG_VERSION'))) {
  console.log('Creating the local PostgreSQL cluster in .data/dev-pg (first run only)...');
  await server.initialise();
}
await server.start();
const admin = new pg.Client({ connectionString: `postgres://postgres:${password}@127.0.0.1:${port}/postgres` });
await admin.connect();
if ((await admin.query(`SELECT 1 FROM pg_database WHERE datname = 'zentrix'`)).rowCount === 0) await admin.query('CREATE DATABASE zentrix');
await admin.end();

const databaseUrl = `postgres://postgres:${password}@127.0.0.1:${port}/zentrix`;
loadEnvFile();
const defaults: Record<string, string> = {
  APP_MODE: 'test', NODE_ENV: 'development', DATABASE_URL: databaseUrl, DATABASE_APP_ROLE: 'zentrix_app',
  PUBLIC_ORIGIN: 'http://localhost:3000', COOKIE_SECURE: 'false', GEOIP_PROVIDER: 'test-header', ...secrets,
};
for (const [key, value] of Object.entries(defaults)) process.env[key] ??= value;

const stopDb = async () => {
  await server.stop();
};
if (dbOnly) {
  console.log(`PostgreSQL is running. DATABASE_URL=${databaseUrl}\nPress Ctrl+C to stop.`);
  process.on('SIGINT', () => void stopDb().then(() => process.exit(0)));
} else {
  const { boot, migrateAndStamp } = await import('../src/bootstrap.js');
  const { config, logger } = boot('zentrix-dev');
  await migrateAndStamp(config, logger);
  const { createServices } = await import('../src/services.js');
  const services = createServices(config, logger);
  const { seedTestData } = await import('../seeds/test-data.js');
  await seedTestData(services);
  const { networkInterfaces } = await import('node:os');
  const nets = networkInterfaces();
  let lanIp = '127.0.0.1';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        lanIp = net.address;
        break;
      }
    }
  }

  const { createApp } = await import('../src/app.js');
  const { startJobs } = await import('../src/jobs/runner.js');
  const http = createApp(services).listen(config.port, '0.0.0.0', () => {
    console.log(`\n========================================`);
    console.log(` Zentrix Ready for Testing (TEST MODE)`);
    console.log(`========================================`);
    console.log(` > Local:   http://localhost:${config.port}`);
    console.log(` > LAN:     http://${lanIp}:${config.port}`);
    console.log(`========================================\n`);
    console.log('Seeded staff and member credentials: .data/seed-credentials.txt');
  });
  const stopJobs = startJobs(services);
  process.on('SIGINT', () => {
    http.close();
    void (async () => {
      await stopJobs();
      await services.pool.end();
      await stopDb();
      process.exit(0);
    })();
  });
}
