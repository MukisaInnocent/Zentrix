// Test-mode seed data (section 0 and 13). Everything here is fake: placeholder phone numbers, .test email
// addresses, random credentials printed once. It refuses to run in live mode or against a live database.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { databaseMode } from '../src/db/migrate.js';
import { maybeOne, one } from '../src/db/sql.js';
import { withTransaction } from '../src/db/tx.js';
import { randomToken } from '../src/lib/crypto.js';
import { toMinor } from '../src/lib/money.js';
import { DATA_DIR } from '../src/lib/paths.js';
import type { Role } from '../src/modules/auth/context.js';
import { newTotpSecret, otpauthUrl } from '../src/modules/auth/totp.js';
import { createUserDirect } from '../src/modules/users/create.js';
import type { PoolClient } from '../src/db/pool.js';
import { confirmDeposit, submitDeposit } from '../src/modules/payments/deposits.js';
import { decideTreasury, requestTreasury } from '../src/modules/payments/treasury.js';
import { requestWithdrawal } from '../src/modules/payments/withdrawals.js';
import { activateMembership } from '../src/modules/wallet/service.js';
import type { Services } from '../src/services.js';

interface ConfigSeed {
  country: string;
  fee: string;
  min: string;
  max: string;
  daily: string;
  monthly: string;
  approval: string;
  placeholderNote: string;
}

// Uganda carries the owner's withdrawal decisions of 2026-10-21 (0.5% fee, UGX 1,000 minimum, approval from
// UGX 200,000); the fee is the master prompt's default, still TODO(owner). Other markets are placeholders.
const CONFIGS: ConfigSeed[] = [
  { country: 'UG', fee: '19000', min: '1000', max: '1000000', daily: '2000000', monthly: '10000000', approval: '200000',
    placeholderNote: 'Withdrawal fee, minimum and approval threshold set by the owner on 2026-10-21. Membership fee and maximums: TODO(owner).' },
  { country: 'KE', fee: '750', min: '50', max: '50000', daily: '100000', monthly: '500000', approval: '10000', placeholderNote: 'Placeholder values, TODO(owner).' },
  { country: 'NG', fee: '7500', min: '500', max: '500000', daily: '1000000', monthly: '5000000', approval: '100000', placeholderNote: 'Placeholder values, TODO(owner).' },
  { country: 'TZ', fee: '13000', min: '1000', max: '1000000', daily: '2000000', monthly: '10000000', approval: '200000', placeholderNote: 'Placeholder values, TODO(owner).' },
  { country: 'RW', fee: '7000', min: '500', max: '500000', daily: '1000000', monthly: '5000000', approval: '100000', placeholderNote: 'Placeholder values, TODO(owner).' },
  { country: 'US', fee: '5.00', min: '1.00', max: '500.00', daily: '1000.00', monthly: '5000.00', approval: '100.00', placeholderNote: 'Placeholder values, TODO(owner).' },
  { country: 'GB', fee: '4.00', min: '1.00', max: '400.00', daily: '800.00', monthly: '4000.00', approval: '80.00', placeholderNote: 'Placeholder values, TODO(owner).' },
  { country: 'KW', fee: '1.500', min: '0.300', max: '150.000', daily: '300.000', monthly: '1500.000', approval: '30.000', placeholderNote: 'Placeholder values (3-decimal currency), TODO(owner).' },
  { country: 'JP', fee: '750', min: '150', max: '75000', daily: '150000', monthly: '750000', approval: '15000', placeholderNote: 'Placeholder values (0-decimal currency), TODO(owner).' },
];

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
    for (const c of CONFIGS) {
      const { currency_code: currency, exponent } = await one<{ currency_code: string; exponent: number }>(
        db, 'SELECT c.currency_code, k.exponent FROM countries c JOIN currencies k ON k.code = c.currency_code WHERE c.code = $1', [c.country],
      );
      const m = (v: string) => toMinor(v, exponent);
      await db.query(
        `INSERT INTO country_configs (country_code, version, currency_code, membership_fee_minor, withdrawal_min_minor, withdrawal_max_minor,
           withdrawal_daily_max_minor, withdrawal_monthly_max_minor, withdrawal_fee_bp, withdrawal_fee_min_minor,
           withdrawal_approval_threshold_minor, terms_version, privacy_version, is_placeholder, note)
         SELECT $1, coalesce(max(version), 0) + 1, $2, $3, $4, $5, $6, $7, 50, 0, $8, '2026-10-v1', '2026-10-v1', true, $9
         FROM country_configs WHERE country_code = $1`,
        [c.country, currency, m(c.fee), m(c.min), m(c.max), m(c.daily), m(c.monthly), m(c.approval), c.placeholderNote],
      );
    }

    const staffIds: Record<string, number> = {};
    for (const [i, s] of STAFF.entries()) {
      const totpSecret = newTotpSecret();
      // SEED_ADMIN_EMAIL gives zx_admin a real inbox so sign-in codes can be emailed (owner, 2026-10-24).
      const adminEmail = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
      const email = s.username === 'zx_admin' && adminEmail ? adminEmail : `${s.username}@zentrix.test`;
      staffIds[s.username] = (await createUserDirect(db, config.dataEncryptionKey, {
        username: s.username, email, phone: `+25670020${String(i + 1).padStart(4, '0')}`, country: 'UG', dateOfBirth: '1990-01-01',
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
        // A few referral links so the Team page has data (rewards are single level, recorded on membership).
        let referrerId: number | null = null;
        if (n === 2) referrerId = memberIds[0] ?? null;
        else if (n === 3) referrerId = memberIds[1] ?? null;
        else if (n === 4) referrerId = memberIds[2] ?? null;
        else if (n === 5) referrerId = memberIds[0] ?? null;
        else if (n === 6) referrerId = memberIds[4] ?? null;

        const created = await createUserDirect(db, config.dataEncryptionKey, {
          username, email: `${username}@zentrix.test`, phone: group.phone(k), country: group.country, dateOfBirth: '1995-06-15',
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
    'Zentrix TEST MODE seed credentials (fake accounts, no real money).',
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

// Fake money through the real flows: two test channels with placeholder numbers, owner capital and a task
// budget approved by a second admin (maker-checker), one confirmed deposit and membership, and open items
// so the staff console has something in every queue.
async function seedPayments(db: PoolClient, staffIds: Record<string, number>, memberIds: number[]): Promise<void> {
  const admin = staffIds.zx_admin!;
  const finance = staffIds.zx_finance!;
  for (const c of [
    { code: 'mtn_ug_test', name: 'MTN Mobile Money', number: '0700 000 001' },
    { code: 'airtel_ug_test', name: 'Airtel Money', number: '0750 000 001' },
  ]) {
    await db.query(
      `INSERT INTO payment_channels (code, name, country_code, currency_code, account_name, account_number, instructions)
       VALUES ($1, $2, 'UG', 'UGX', 'ZENTRIX TEST', $3, 'TEST MODE: placeholder number. Do not send real money.')`,
      [c.code, c.name, c.number],
    );
  }
  const capital = await requestTreasury(db, finance, { kind: 'capital_in', currency: 'UGX', amountMinor: 2_000_000n, channel: 'mtn_ug_test', externalRef: 'SEED-CAPITAL-1', note: 'Fake test capital' });
  await decideTreasury(db, admin, capital, true, 'Seed');
  const budget = await requestTreasury(db, finance, { kind: 'fund_budget', currency: 'UGX', amountMinor: 500_000n, source: 'owner_capital', budget: 'promotions_budget', note: 'Fake task budget' });
  await decideTreasury(db, admin, budget, true, 'Seed');

  const [m1, m2, m3] = memberIds;
  if (m1 === undefined || m2 === undefined || m3 === undefined) return;
  const phoneOf = async (id: number) => (await db.query<{ phone_e164: string }>('SELECT phone_e164 FROM users WHERE id = $1', [id])).rows[0]!.phone_e164;
  const d1 = await submitDeposit(db, m1, { channelCode: 'mtn_ug_test', amountMinor: 50_000n, senderPhone: await phoneOf(m1), providerTxnId: 'SEED-MTN-0001' });
  await confirmDeposit(db, finance, d1.id, 50_000n, null);
  await activateMembership(db, m1);
  await requestWithdrawal(db, m1, { source: 'main', amountMinor: 5_000n, channelCode: 'mtn_ug_test' });
  await submitDeposit(db, m2, { channelCode: 'mtn_ug_test', amountMinor: 19_000n, senderPhone: await phoneOf(m2), providerTxnId: 'SEED-MTN-0002', note: 'For membership' });
  await submitDeposit(db, m3, { channelCode: 'airtel_ug_test', amountMinor: 25_000n, senderPhone: await phoneOf(m3), providerTxnId: 'SEED-AIR-0001' });
}
