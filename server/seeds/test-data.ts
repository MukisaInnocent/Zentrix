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
  { country: 'UG', phone: n => `+2567000100${String(n).padStart(2, '0')}`, count: 12 },
  { country: 'KE', phone: n => `+2547000001${String(n).padStart(2, '0')}`, count: 3 },
  { country: 'NG', phone: n => `+23480300001${String(n).padStart(2, '0')}`, count: 2 },
  { country: 'GB', phone: n => `+447700900${String(100 + n)}`, count: 2 },
  { country: 'US', phone: n => `+1201555${String(100 + n).padStart(4, '0')}`, count: 1 },
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
  const report: SeedReport = { staffPassword: `Staff-${randomToken(9)}`, memberPassword: `Member-${randomToken(9)}`, staff: [], members: [] };
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

    for (const [i, s] of STAFF.entries()) {
      const totpSecret = newTotpSecret();
      const email = `${s.username}@zentrix.test`;
      await createUserDirect(db, config.dataEncryptionKey, {
        username: s.username, email, phone: `+2567000200${String(i + 1).padStart(2, '0')}`, country: 'UG', dateOfBirth: '1990-01-01',
        password: report.staffPassword, roles: s.roles, verified: true, totpSecret,
      });
      report.staff.push({ username: s.username, email, roles: s.roles, totpSecret, otpauthUrl: otpauthUrl(totpSecret, s.username) });
    }

    let n = 0;
    let firstReferrer: number | null = null;
    for (const group of MEMBERS) {
      for (let k = 1; k <= group.count; k++) {
        n += 1;
        const username = `test_member_${String(n).padStart(2, '0')}`;
        // Single-level referrals only (rule 3.2): member 01 refers members 02 to 04.
        const referrerId = n >= 2 && n <= 4 ? firstReferrer : null;
        const created = await createUserDirect(db, config.dataEncryptionKey, {
          username, email: `${username}@zentrix.test`, phone: group.phone(k), country: group.country, dateOfBirth: '1995-06-15',
          password: report.memberPassword, roles: ['member'], verified: n % 5 !== 0, referrerId,
        });
        if (n === 1) firstReferrer = created.id;
        report.members.push(username);
      }
    }
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
