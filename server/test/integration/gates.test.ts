import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../../src/config/env.js';
import { assertStartupGates } from '../../src/config/gates.js';
import { createUserDirect } from '../../src/modules/users/create.js';
import { recordSignoff } from '../../src/modules/golive/service.js';
import { withTransaction } from '../../src/db/tx.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

let db: TestDatabase;
// Gates run through the restricted app role in production, so the tests do too.
let pool: pg.Pool;

const configFor = (mode: 'test' | 'live', url: string): Config =>
  mode === 'test'
    ? loadConfig({ DATABASE_URL: url, CSRF_SECRET: 'c'.repeat(40), DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64') })
    : loadConfig({
        APP_MODE: 'live', NODE_ENV: 'production', DATABASE_URL: url, DATABASE_SSL: 'require', CSRF_SECRET: 'c'.repeat(40),
        DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'), PUBLIC_ORIGIN: 'https://zentrix.example', SMTP_URL: 'smtp://mail.example',
      });

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=zentrix_app' });
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('start-up gates', () => {
  it('lets a test server use a test database', async () => {
    await expect(assertStartupGates(configFor('test', db.url), pool)).resolves.toBeUndefined();
  });

  it('refuses to run live against a test database (fake balances never go live)', async () => {
    await expect(assertStartupGates(configFor('live', db.url), pool)).rejects.toThrow(/stamped "test"/);
  });

  it('refuses a live database to a test server, and refuses live until every checklist item is signed', async () => {
    const live = await createTestDatabase();
    const livePool = new pg.Pool({ connectionString: live.url });
    try {
      await livePool.query('ALTER TABLE system_meta DISABLE TRIGGER system_meta_append_only');
      await livePool.query(`UPDATE system_meta SET database_mode = 'live'`);
      await livePool.query('ALTER TABLE system_meta ENABLE TRIGGER system_meta_append_only');
      await expect(assertStartupGates(configFor('test', live.url), livePool)).rejects.toThrow(/stamped "live"/);
      await expect(assertStartupGates(configFor('live', live.url), livePool)).rejects.toThrow(/go-live checklist/);

      const adminId = await withTransaction(livePool, async c => {
        const u = await createUserDirect(c, randomBytes(32), {
          username: 'gate_admin', email: 'gate_admin@zentrix.test', phone: '+256700777001', country: 'UG',
          password: 'correct-horse-battery-9', roles: ['admin'], verified: true,
        });
        return u.id;
      });
      const items = (await livePool.query<{ key: string }>('SELECT key FROM go_live_items')).rows.map(r => r.key);
      for (const key of items.slice(0, -1)) await recordSignoff(livePool, key, adminId, 'sign', null);
      await expect(assertStartupGates(configFor('live', live.url), livePool)).rejects.toThrow(/owner_approval/);
      await recordSignoff(livePool, items.at(-1)!, adminId, 'sign', null);
      await expect(assertStartupGates(configFor('live', live.url), livePool)).resolves.toBeUndefined();
      await recordSignoff(livePool, items[0]!, adminId, 'revoke', 'keys rotated');
      await expect(assertStartupGates(configFor('live', live.url), livePool)).rejects.toThrow(/go-live checklist/);
    } finally {
      await livePool.end();
      await live.drop();
    }
  }, 90_000);

  it('refuses to start with pending migrations', async () => {
    const stale = await createTestDatabase();
    const stalePool = new pg.Pool({ connectionString: stale.url });
    try {
      await stalePool.query(`DELETE FROM pgmigrations WHERE name = '0004_settings'`);
      await expect(assertStartupGates(configFor('test', stale.url), stalePool)).rejects.toThrow(/pending migrations: 0004_settings/);
    } finally {
      await stalePool.end();
      await stale.drop();
    }
  });
});
