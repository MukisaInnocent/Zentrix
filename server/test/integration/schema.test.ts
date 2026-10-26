import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pendingMigrations } from '../../src/db/migrate.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;

beforeAll(async () => {
  db = await createTestDatabase();
  owner = new pg.Pool({ connectionString: db.url });
  app = new pg.Pool({ connectionString: db.url, options: '-c role=zentrix_app' });
});
afterAll(async () => {
  await app.end();
  await owner.end();
  await db.drop();
});

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

let phoneSeq = 100;
const refCode = (n: number) => `TEST${String(n).replace(/[01]/g, d => (d === '0' ? 'A' : 'B')).padStart(4, 'Z')}`;
async function insertUser(username: string, referrer: number | null = null): Promise<number> {
  phoneSeq += 1;
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO users (username, email, phone_e164, password_hash, country_code, currency_code, locale, timezone,
       referral_code, referred_by_user_id)
     VALUES ($1, $1 || '@zentrix.test', $2, 'x', 'UG', 'UGX', 'en-UG', 'Africa/Kampala', $4, $3)
     RETURNING id`,
    [username, `+256700000${phoneSeq}`, referrer, refCode(phoneSeq)],
  );
  return Number(rows[0]!.id);
}

const configInsert = `INSERT INTO country_configs (country_code, version, currency_code, membership_fee_minor,
    withdrawal_min_minor, withdrawal_max_minor, withdrawal_daily_max_minor, withdrawal_monthly_max_minor,
    withdrawal_fee_bp, withdrawal_approval_threshold_minor, terms_version, privacy_version)
  VALUES ($1, $2, $3, 19000, $4, 1000000, 2000000, 10000000, 50, 200000, '2026-10', '2026-10')`;

describe('migrations', () => {
  it('applies every migration file', async () => {
    expect(await pendingMigrations(owner)).toEqual([]);
  });

  it('stamps the database as test and refuses changes to the stamp', async () => {
    const { rows } = await owner.query('SELECT database_mode FROM system_meta');
    expect(rows).toEqual([{ database_mode: 'test' }]);
    expect(await sqlState(owner.query(`UPDATE system_meta SET database_mode = 'live'`))).toBe('ZX001');
    expect(await sqlState(owner.query('DELETE FROM system_meta'))).toBe('ZX001');
    expect(await sqlState(owner.query('TRUNCATE system_meta'))).toBe('ZX001');
  });
});

describe('reference data', () => {
  it('has ISO currencies with the right exponents and Uganda configured', async () => {
    const cur = await owner.query(
      `SELECT code, exponent FROM currencies WHERE code IN ('UGX','USD','KWD','JPY') ORDER BY code`,
    );
    expect(cur.rows).toEqual([
      { code: 'JPY', exponent: 0 },
      { code: 'KWD', exponent: 3 },
      { code: 'UGX', exponent: 0 },
      { code: 'USD', exponent: 2 },
    ]);
    const ug = await owner.query(
      `SELECT currency_code, dial_code, default_timezone, blocked FROM countries WHERE code = 'UG'`,
    );
    expect(ug.rows[0]).toEqual({
      currency_code: 'UGX',
      dial_code: '256',
      default_timezone: 'Africa/Kampala',
      blocked: false,
    });
    const count = await owner.query<{ n: string }>('SELECT count(*) AS n FROM countries');
    expect(Number(count.rows[0]!.n)).toBeGreaterThan(240);
  });
});

describe('restricted application role', () => {
  it('connects as zentrix_app', async () => {
    const { rows } = await app.query('SELECT current_user AS u');
    expect(rows[0]).toEqual({ u: 'zentrix_app' });
  });

  it('cannot rewrite the audit log, delete users or delete countries', async () => {
    await owner.query(`INSERT INTO audit_log (action) VALUES ('test.entry')`);
    expect(await sqlState(app.query(`UPDATE audit_log SET action = 'x.y.z'`))).toBe('42501');
    expect(await sqlState(app.query('DELETE FROM audit_log'))).toBe('42501');
    expect(await sqlState(app.query(`DELETE FROM countries WHERE code = 'UG'`))).toBe('42501');
    expect(await sqlState(app.query('DELETE FROM users'))).toBe('42501');
  });

  it('still blocks the owner through triggers, so protection holds without the role', async () => {
    expect(await sqlState(owner.query(`UPDATE audit_log SET action = 'x.y.z'`))).toBe('ZX001');
    expect(await sqlState(owner.query('TRUNCATE audit_log'))).toBe('ZX001');
  });
});

describe('users guard', () => {
  it('locks the referrer, identity columns and, without an admin flag, country and phone', async () => {
    const referrer = await insertUser('guard_referrer');
    const other = await insertUser('guard_other');
    const member = await insertUser('guard_member', referrer);
    const update = (sql: string, params: unknown[]) => sqlState(owner.query(sql, params));
    expect(await update('UPDATE users SET referred_by_user_id = $1 WHERE id = $2', [other, member])).toBe('ZX002');
    expect(await update('UPDATE users SET referred_by_user_id = NULL WHERE id = $1', [member])).toBe('ZX002');
    expect(await update(`UPDATE users SET referral_code = 'ZZZZZZZZ' WHERE id = $1`, [member])).toBe('ZX002');
    expect(await update(`UPDATE users SET country_code = 'KE', currency_code = 'KES' WHERE id = $1`, [member])).toBe(
      'ZX002',
    );
    expect(await update(`UPDATE users SET phone_e164 = '+256700999999' WHERE id = $1`, [member])).toBe('ZX002');
    expect(await update('DELETE FROM users WHERE id = $1', [member])).toBe('ZX001');
  });

  it('allows an admin-flagged phone change inside a transaction, and only there', async () => {
    const member = await insertUser('guard_phone');
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('zentrix.admin_change', 'on', true)`);
      await client.query(`UPDATE users SET phone_e164 = '+256700888888' WHERE id = $1`, [member]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const { rows } = await owner.query('SELECT phone_e164 FROM users WHERE id = $1', [member]);
    expect(rows[0]).toEqual({ phone_e164: '+256700888888' });
    const again = owner.query(`UPDATE users SET phone_e164 = '+256700777777' WHERE id = $1`, [member]);
    expect(await sqlState(again)).toBe('ZX002');
  });

  it('rejects self-referral', async () => {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO users (username, email, phone_e164, password_hash, country_code, currency_code, locale, timezone,
         referral_code)
       VALUES ('guard_self', 'guard_self@zentrix.test', '+256700000999', 'x', 'UG', 'UGX', 'en-UG', 'Africa/Kampala',
         'SELFABCD') RETURNING id`,
    );
    const id = rows[0]!.id;
    const insertSelf = owner.query(
      `INSERT INTO users (id, username, email, phone_e164, password_hash, country_code, currency_code, locale, timezone,
         referral_code, referred_by_user_id)
       OVERRIDING SYSTEM VALUE VALUES (999999, 'guard_self2', 'guard_self2@zentrix.test', '+256700000998', 'x', 'UG',
         'UGX', 'en-UG', 'Africa/Kampala', 'SELFABCE', 999999)`,
    );
    expect(await sqlState(insertSelf)).toBe('23514');
    expect(id).toBeDefined();
  });
});

describe('country configuration', () => {
  it('requires the country currency, keeps limits ordered and is append-only', async () => {
    // Migration 0007 ships Uganda's config as version 1 (fee UGX 19,000); 0014 adds version 2 (withdrawal limits).
    expect((await owner.query(`SELECT membership_fee_minor FROM country_configs WHERE country_code = 'UG' AND version = 1`)).rows[0]?.membership_fee_minor).toBe('19000');
    expect(await sqlState(owner.query(configInsert, ['UG', 3, 'USD', 1000]))).toBe('ZX003');
    await owner.query(configInsert, ['UG', 3, 'UGX', 1000]);
    const update = owner.query(`UPDATE country_configs SET membership_fee_minor = 1 WHERE country_code = 'UG'`);
    expect(await sqlState(update)).toBe('ZX001');
    // Minimum above the per-request maximum violates a CHECK.
    expect(await sqlState(owner.query(configInsert, ['UG', 4, 'UGX', 5_000_000]))).toBe('23514');
  });
});
