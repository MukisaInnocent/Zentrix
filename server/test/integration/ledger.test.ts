import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/tx.js';
import { accountId, InsufficientFundsError, move, post } from '../../src/modules/ledger/ledger.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { registerMember } from '../helpers/factories.js';

// Database-level ledger rules (section 5), exercised as the restricted application role.
let app: TestApp;
let userId: number;

beforeAll(async () => {
  app = await startTestApp();
  const member = await registerMember(app);
  userId = Number((await app.owner.query<{ id: string }>('SELECT id FROM users WHERE public_id = $1', [member.user.id])).rows[0]!.id);
});
afterAll(async () => {
  await app.close();
});

const appPool = () => app.services.pool;
const code = (err: unknown) => (err as { code?: string }).code;

async function seedCapital(amount: bigint): Promise<{ capital: number; main: number }> {
  return withTransaction(appPool(), async db => {
    const channel = (await db.query<{ id: string }>(
      `INSERT INTO payment_channels (code, name, country_code, currency_code, account_name, account_number)
       VALUES ('l_' || substr(md5(random()::text), 1, 8), 'Test rail', 'UG', 'UGX', 'TEST', '0700000000') RETURNING id`,
    )).rows[0]!.id;
    const cash = await accountId(db, { kind: 'payment_clearing', channelId: Number(channel), currency: 'UGX' });
    const capital = await accountId(db, { kind: 'owner_capital', currency: 'UGX' });
    const main = await accountId(db, { kind: 'member_main', userId, currency: 'UGX' });
    await post(db, { kind: 'test_capital', memo: 'test', legs: move(cash, capital, amount) });
    return { capital, main };
  });
}

describe('ledger', () => {
  it('opens accounts at zero and moves cached balances only through entries', async () => {
    const { capital, main } = await seedCapital(10_000n);
    await withTransaction(appPool(), db => post(db, { kind: 'test_move', memo: 'move', legs: move(capital, main, 4_000n) }));
    const balances = await app.owner.query<{ id: string; balance_minor: string }>('SELECT id, balance_minor FROM accounts WHERE id = ANY($1)', [[capital, main]]);
    expect(Object.fromEntries(balances.rows.map(r => [Number(r.id), r.balance_minor]))).toEqual({ [capital]: '6000', [main]: '4000' });
    const recomputed = await app.owner.query<{ drift: string }>(
      `SELECT count(*) AS drift FROM accounts a WHERE a.balance_minor <> coalesce((SELECT sum(CASE WHEN e.side = a.normal_side THEN e.amount_minor ELSE -e.amount_minor END) FROM ledger_entries e WHERE e.account_id = a.id), 0)`,
    );
    expect(recomputed.rows[0]!.drift).toBe('0');
    await expect(withTransaction(appPool(), db => db.query("INSERT INTO accounts (kind, currency_code, balance_minor) VALUES ('suspense', 'KES', 999)")))
      .resolves.toBeDefined();
    const opened = await app.owner.query<{ balance_minor: string }>("SELECT balance_minor FROM accounts WHERE kind = 'suspense' AND currency_code = 'KES'");
    expect(opened.rows[0]!.balance_minor).toBe('0');
  });

  it('rejects a direct balance update, even for the database owner', async () => {
    const { main } = await seedCapital(1_000n);
    await expect(appPool().query('UPDATE accounts SET balance_minor = 1 WHERE id = $1', [main])).rejects.toSatisfy(e => ['42501', 'ZX001'].includes(code(e) ?? ''));
    await expect(app.owner.query('UPDATE accounts SET balance_minor = 1 WHERE id = $1', [main])).rejects.toSatisfy(e => code(e) === 'ZX001');
  });

  it('rejects edits and deletes of ledger rows', async () => {
    await seedCapital(1_000n);
    await expect(app.owner.query('UPDATE ledger_entries SET amount_minor = amount_minor + 1')).rejects.toSatisfy(e => code(e) === 'ZX001');
    await expect(app.owner.query('DELETE FROM ledger_transactions')).rejects.toSatisfy(e => code(e) === 'ZX001');
    await expect(app.owner.query('TRUNCATE ledger_entries CASCADE')).rejects.toBeDefined();
  });

  it('rejects an unbalanced transaction at commit', async () => {
    const { capital, main } = await seedCapital(5_000n);
    const attempt = withTransaction(app.owner, async db => {
      const txn = (await db.query<{ id: string }>(`INSERT INTO ledger_transactions (kind, memo) VALUES ('bad_txn', 'x') RETURNING id`)).rows[0]!.id;
      await db.query(`INSERT INTO ledger_entries (transaction_id, account_id, side, amount_minor, currency_code) VALUES ($1, $2, 'debit', 100, 'UGX'), ($1, $3, 'credit', 90, 'UGX')`, [txn, capital, main]);
    });
    await expect(attempt).rejects.toSatisfy(e => code(e) === 'ZX011');
  });

  it('rejects an entry in a different currency from its account', async () => {
    const { capital, main } = await seedCapital(5_000n);
    const attempt = withTransaction(app.owner, async db => {
      const txn = (await db.query<{ id: string }>(`INSERT INTO ledger_transactions (kind, memo) VALUES ('bad_ccy', 'x') RETURNING id`)).rows[0]!.id;
      await db.query(`INSERT INTO ledger_entries (transaction_id, account_id, side, amount_minor, currency_code) VALUES ($1, $2, 'debit', 100, 'KES'), ($1, $3, 'credit', 100, 'KES')`, [txn, capital, main]);
    });
    await expect(attempt).rejects.toSatisfy(e => code(e) === 'ZX010');
  });

  it('refuses to take an account below zero, in code and in the database', async () => {
    const { capital, main } = await seedCapital(100n);
    const revenue = await accountId(appPool(), { kind: 'platform_revenue', currency: 'UGX' });
    await expect(withTransaction(appPool(), db => post(db, { kind: 'test_overdraw', memo: 'x', legs: move(main, revenue, 10_000_000n) }))).rejects.toBeInstanceOf(InsufficientFundsError);
    const bypass = withTransaction(app.owner, async db => {
      const txn = (await db.query<{ id: string }>(`INSERT INTO ledger_transactions (kind, memo) VALUES ('raw_overdraw', 'x') RETURNING id`)).rows[0]!.id;
      await db.query(`INSERT INTO ledger_entries (transaction_id, account_id, side, amount_minor, currency_code) VALUES ($1, $2, 'debit', 999999999, 'UGX'), ($1, $3, 'credit', 999999999, 'UGX')`, [txn, capital, revenue]);
    });
    await expect(bypass).rejects.toSatisfy(e => code(e) === '23514');
  });

  it('serialises concurrent debits so an account is never overdrawn', async () => {
    const { capital } = await seedCapital(3_000n);
    const before = BigInt((await app.owner.query<{ balance_minor: string }>('SELECT balance_minor FROM accounts WHERE id = $1', [capital])).rows[0]!.balance_minor);
    const revenue = await accountId(appPool(), { kind: 'platform_revenue', currency: 'UGX' });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => withTransaction(appPool(), db => post(db, { kind: 'test_race', memo: 'race', legs: move(capital, revenue, before / 2n) }), { isolation: 'serializable' })),
    );
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2);
    const after = (await app.owner.query<{ balance_minor: string }>('SELECT balance_minor FROM accounts WHERE id = $1', [capital])).rows[0]!.balance_minor;
    expect(BigInt(after)).toBe(before - 2n * (before / 2n));
  });
});
