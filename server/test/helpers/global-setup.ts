import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { runMigrations, stampDatabaseMode } from '../../src/db/migrate.js';
import { createLogger } from '../../src/lib/logger.js';
import { DATA_DIR } from '../../src/lib/paths.js';
import { TEMPLATE_DB, withDatabase } from './urls.js';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

// Starts one real PostgreSQL for the whole run (embedded, unless TEST_DATABASE_URL points at one, as in
// CI) and builds a migrated template database that every test file clones.
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let adminUrl = process.env.TEST_DATABASE_URL;
  let stopServer: (() => Promise<void>) | undefined;
  if (!adminUrl) {
    mkdirSync(DATA_DIR, { recursive: true });
    const dir = mkdtempSync(path.join(DATA_DIR, 'test-pg-'));
    const port = await freePort();
    const password = 'zentrix-test-only';
    const server = new EmbeddedPostgres({
      databaseDir: dir, port, user: 'postgres', password, persistent: false,
      onLog: () => undefined, onError: () => undefined,
    });
    await server.initialise();
    await server.start();
    adminUrl = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
    stopServer = async () => {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    };
  }

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB}`);
  await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  await admin.end();

  const templateUrl = withDatabase(adminUrl, TEMPLATE_DB);
  await runMigrations({ url: templateUrl, ssl: 'disable', logger: createLogger({ level: 'warn', mode: 'test' }) });
  const pool = new pg.Pool({ connectionString: templateUrl });
  await stampDatabaseMode(pool, 'test');
  await pool.end();

  project.provide('pgAdminUrl', adminUrl);
  return async () => {
    if (stopServer) await stopServer();
  };
}
