// Test-mode seed data (section 0 and 13). Everything here is fake: placeholder phone numbers, .test email
// addresses, random credentials printed once. It refuses to run in live mode or against a live database.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { databaseMode } from '../src/db/migrate.js';
import { maybeOne } from '../src/db/sql.js';
import { withTransaction } from '../src/db/tx.js';
import { randomToken } from '../src/lib/crypto.js';
import { DATA_DIR } from '../src/lib/paths.js';
import type { Role } from '../src/modules/auth/context.js';
import { newTotpSecret, otpauthUrl } from '../src/modules/auth/totp.js';
import { createUserDirect } from '../src/modules/users/create.js';
import type { PoolClient } from '../src/db/pool.js';
import { confirmDeposit, submitDeposit } from '../src/modules/payments/deposits.js';
import { decideTreasury, requestTreasury } from '../src/modules/payments/treasury.js';
import { requestWithdrawal } from '../src/modules/payments/withdrawals.js';
import type { Services } from '../src/services.js';

const STAFF: { username: string; roles: Role[] }[] = [
  { username: 'zx_admin', roles: ['admin', 'member'] },
  { username: 'zx_finance', roles: ['finance', 'member'] },
  { username: 'zx_reviewer', roles: ['reviewer', 'member'] },
  { username: 'zx_support', roles: ['support', 'member'] },
  { username: 'zx_compliance', roles: ['compliance', 'member'] },
];

// Placeholder numbers: Uganda 7000100NN pattern, UK Ofcom drama range, US 555-01NN fiction range.
const MEMBERS: { country: string; phone: (n: number) => string; count: number }[] = [
  { country: 'UG', phone: n => `+25670010${String(n).padStart(4, '0')}`, count: 12 },
  { country: 'KE', phone: n => `+25470010${String(n).padStart(4, '0')}`, count: 3 },
  { country: 'NG', phone: n => `+234803${String(n).padStart(7, '0')}`, count: 2 },
  { country: 'GB', phone: n => `+44770010${String(n).padStart(4, '0')}`, count: 2 },
  { country: 'US', phone: n => `+120155501${String(n).padStart(2, '0')}`, count: 1 },
];

export interface SeedReport {
  staffPassword: string;
  memberPassword: string;
  staff: { username: string; email: string; roles: Role[]; totpSecret: string; otpauthUrl: string }[];
  members: string[];
}

export async function seedTestData(services: Services): Promise<SeedReport | null> {
  const { pool, config, logger } = services;
  if (config.appMode !== 'test' || (await databaseMode(pool)) !== 'test') {
    throw new Error('Seed data is test-only. Refusing to seed outside test mode or into a live database.');
  }
  if (await maybeOne(pool, `SELECT 1 FROM users WHERE username = 'zx_admin'`)) {
    logger.info('seed data already present; skipping');
    return null;
  }
  // SEED_STAFF_PASSWORD / SEED_MEMBER_PASSWORD keep test logins the same across environments (owner, 2026-10-24).
  const report: SeedReport = {
    staffPassword: process.env.SEED_STAFF_PASSWORD?.trim() || `Staff-${randomToken(9)}`,
    memberPassword: process.env.SEED_MEMBER_PASSWORD?.trim() || `Member-${randomToken(9)}`,
    staff: [], members: [],
  };
  await withTransaction(pool, async db => {
    const staffIds: Record<string, number> = {};
    for (const [i, s] of STAFF.entries()) {
      const totpSecret = newTotpSecret();
      // SEED_ADMIN_EMAIL gives zx_admin a real inbox so sign-in codes can be emailed (owner, 2026-10-24).
      const adminEmail = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
      const email = s.username === 'zx_admin' && adminEmail ? adminEmail : `${s.username}@zentrix.test`;
      staffIds[s.username] = (await createUserDirect(db, config.dataEncryptionKey, {
        username: s.username, email, phone: `+25670020${String(i + 1).padStart(4, '0')}`, country: 'UG',
        password: report.staffPassword, roles: s.roles, verified: true, totpSecret,
      })).id;
      report.staff.push({ username: s.username, email, roles: s.roles, totpSecret, otpauthUrl: otpauthUrl(totpSecret, s.username) });
    }

    let n = 0;
    const memberIds: number[] = [];
    for (const group of MEMBERS) {
      for (let k = 1; k <= group.count; k++) {
        n += 1;
        const username = `test_member_${String(n).padStart(2, '0')}`;
        // A few referral links so the Referrals pages have data: members 2 to 4 form a chain under member 1.
        let referrerId: number | null = null;
        if (n === 2) referrerId = memberIds[0] ?? null;
        else if (n === 3) referrerId = memberIds[1] ?? null;
        else if (n === 4) referrerId = memberIds[2] ?? null;
        else if (n === 5) referrerId = memberIds[0] ?? null;
        else if (n === 6) referrerId = memberIds[4] ?? null;

        const created = await createUserDirect(db, config.dataEncryptionKey, {
          username, email: `${username}@zentrix.test`, phone: group.phone(k), country: group.country,
          password: report.memberPassword, roles: ['member'], verified: true, referrerId,
        });
        memberIds.push(created.id);
        report.members.push(username);
      }
    }

    const { ensureDefaultTasks } = await import('../src/modules/tasks/service.js');
    await ensureDefaultTasks(db);
    await seedPayments(db, staffIds, memberIds);
  });

  const lines = [
    'Pexerearn TEST MODE seed credentials (fake accounts, no real money).',
    `Staff password: ${report.staffPassword}`,
    `Member password: ${report.memberPassword} (users ${report.members[0]} to ${report.members.at(-1)})`,
    ...report.staff.map(s => `${s.username} [${s.roles.join(', ')}] TOTP secret ${s.totpSecret}`),
  ];
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(path.join(DATA_DIR, 'seed-credentials.txt'), `${lines.join('\n')}\n`);
  } catch {
    // Read-only file systems (containers) still get the log output below.
  }
  logger.warn({ credentials: lines }, 'test seed created: fake accounts and their one-time credentials');
  return report;
}

// Fake money through the real flows: test payment channels for several countries (placeholder codes, never real),
// owner capital and a task budget approved by a second admin (maker-checker), a chain of four activated members so
// referral rewards appear, one withdrawal request, and activation payments waiting for review.
async function seedPayments(db: PoolClient, staffIds: Record<string, number>, memberIds: number[]): Promise<void> {
  const admin = staffIds.zx_admin!;
  const finance = staffIds.zx_finance!;
  const test = 'TEST MODE: placeholder codes. Do not send real money.';
  for (const c of [
    { code: 'mtn_ug_test', name: 'MTN Mobile Money', country: 'UG', ussd: '*165*3#', merchant: '123456', instructions: test },
    { code: 'airtel_ug_test', name: 'Airtel Money', country: 'UG', ussd: '*185*9#', merchant: '654321', instructions: test },
    { code: 'mpesa_ke_test', name: 'M-Pesa Paybill', country: 'KE', ussd: '*334#', merchant: '000111', instructions: test },
    { code: 'mpesa_tz_test', name: 'M-Pesa', country: 'TZ', ussd: null, merchant: '000222', instructions: test },
    { code: 'momo_rw_test', name: 'MTN MoMo', country: 'RW', ussd: null, merchant: '000333', instructions: test },
    { code: 'bank_ng_test', name: 'Bank transfer', country: 'NG', ussd: null, merchant: '0000000000', instructions: `${test} Pay to the account number shown.` },
    { code: 'bank_gb_test', name: 'Bank transfer', country: 'GB', ussd: null, merchant: '00-00-00 00000000', instructions: `${test} Pay to the sort code and account number shown.` },
    { code: 'bank_us_test', name: 'Bank transfer', country: 'US', ussd: null, merchant: '000000000', instructions: `${test} Pay to the account number shown.` },
  ]) {
    await db.query(
      `INSERT INTO payment_channels (code, name, country_code, currency_code, account_name, account_number, ussd_code, merchant_code, instructions)
       SELECT $1, $2, c.code, c.currency_code, 'PEXEREARN TEST', $5, $3, $4, $6 FROM countries c WHERE c.code = $7`,
      [c.code, c.name, c.ussd, c.merchant, c.merchant, c.instructions, c.country],
    );
  }
  const capital = await requestTreasury(db, finance, { kind: 'capital_in', currency: 'UGX', amountMinor: 2_000_000n, channel: 'mtn_ug_test', externalRef: 'SEED-CAPITAL-1', note: 'Fake test capital' });
  await decideTreasury(db, admin, capital, true, 'Seed');
  const budget = await requestTreasury(db, finance, { kind: 'fund_budget', currency: 'UGX', amountMinor: 500_000n, source: 'owner_capital', budget: 'promotions_budget', note: 'Fake task budget' });
  await decideTreasury(db, admin, budget, true, 'Seed');

  const phoneOf = async (id: number) => (await db.query<{ phone_e164: string }>('SELECT phone_e164 FROM users WHERE id = $1', [id])).rows[0]!.phone_e164;
  const claim = async (id: number, channelCode: string, txn: string) =>
    submitDeposit(db, id, { channelCode, senderPhone: await phoneOf(id), providerTxnId: txn });
  const activate = async (id: number, channelCode: string, txn: string) => {
    const d = await claim(id, channelCode, txn);
    await confirmDeposit(db, finance, d.id, BigInt(d.claimedAmountMinor), null);
  };

  // Members 1 to 4 are a chain (each invited by the one before), so activating them in order pays level 1, 2 and 3.
  for (const [i, id] of memberIds.slice(0, 4).entries()) await activate(id, i % 2 === 0 ? 'mtn_ug_test' : 'airtel_ug_test', `SEED-ACT-000${i + 1}`);
  const [m1, , , , m5, m6, , , , , , , m13] = memberIds;
  if (m1 !== undefined) await requestWithdrawal(db, m1, { source: 'main', amountMinor: 5_000n });
  if (m5 !== undefined) await claim(m5, 'mtn_ug_test', 'SEED-ACT-0005');
  if (m6 !== undefined) await claim(m6, 'airtel_ug_test', 'SEED-ACT-0006');
  if (m13 !== undefined) await claim(m13, 'mpesa_ke_test', 'SEED-ACT-0013');
}
