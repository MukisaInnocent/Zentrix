import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomCode } from '../../src/lib/crypto.js';
import { distributeReferralRewards, getReferralOverview } from '../../src/modules/referrals/service.js';
import { completeTask, listTasks } from '../../src/modules/tasks/service.js';
import { activateMembership, getWalletSummary, recordDeposit, requestWithdrawal } from '../../src/modules/wallet/service.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

let db: TestDatabase;
let pool: pg.Pool;

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.url });
});

afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('multi-level referrals and wallet integration', () => {
  it('distributes UGX 10,000 for level 1, UGX 5,000 for level 2, UGX 2,000 for level 3, and UGX 1,000 for level 4', async () => {
    // Create user chain: A -> B -> C -> D -> E
    const create = async (username: string, referrerId: number | null) => {
      const res = await pool.query<{ id: string }>(
        `INSERT INTO users (username, email, phone_e164, password_hash, country_code, currency_code, locale, timezone, date_of_birth, referral_code, referred_by_user_id)
         VALUES ($1, $2, $3, 'hash', 'UG', 'UGX', 'en', 'Africa/Kampala', '2000-01-01', $4, $5)
         RETURNING id`,
        [username, `${username}@test.com`, `+256700${Math.floor(100000 + Math.random() * 900000)}`, randomCode(8), referrerId],
      );
      return Number(res.rows[0]!.id);
    };

    const userA = await create('user_a_ref', null);
    const userB = await create('user_b_ref', userA); // B invited by A
    const userC = await create('user_c_ref', userB); // C invited by B
    const userD = await create('user_d_ref', userC); // D invited by C
    const userE = await create('user_e_ref', userD); // E invited by D

    // Distribute rewards when B joins
    const resB = await distributeReferralRewards(pool, userB);
    expect(resB.distributedCount).toBe(1);
    expect(resB.totalDistributedMinor).toBe(10_000n);

    // Distribute rewards when C joins
    const resC = await distributeReferralRewards(pool, userC);
    expect(resC.distributedCount).toBe(2);
    expect(resC.totalDistributedMinor).toBe(15_000n); // 10k to B, 5k to A

    // Distribute rewards when D joins
    const resD = await distributeReferralRewards(pool, userD);
    expect(resD.distributedCount).toBe(3);
    expect(resD.totalDistributedMinor).toBe(17_000n); // 10k to C, 5k to B, 2k to A

    // Distribute rewards when E joins
    const resE = await distributeReferralRewards(pool, userE);
    expect(resE.distributedCount).toBe(4);
    expect(resE.totalDistributedMinor).toBe(18_000n); // 10k to D, 5k to C, 2k to B, 1k to A

    // Check User A's wallet:
    // From B (Level 1): 10,000
    // From C (Level 2): 5,000
    // From D (Level 3): 2,000
    // From E (Level 4): 1,000
    // Total = 18,000 UGX
    const summaryA = await getWalletSummary(pool, userA);
    expect(summaryA.availableBalanceMinor).toBe('18000');
    expect(summaryA.totalReferralEarnedMinor).toBe('18000');

    // Check User B's wallet:
    // From C (Level 1): 10,000
    // From D (Level 2): 5,000
    // From E (Level 3): 2,000
    // Total = 17,000 UGX
    const summaryB = await getWalletSummary(pool, userB);
    expect(summaryB.availableBalanceMinor).toBe('17000');

    // Check User C's wallet:
    // From D (Level 1): 10,000
    // From E (Level 2): 5,000
    // Total = 15,000 UGX
    const summaryC = await getWalletSummary(pool, userC);
    expect(summaryC.availableBalanceMinor).toBe('15000');

    // Check User D's wallet:
    // From E (Level 1): 10,000 UGX
    const summaryD = await getWalletSummary(pool, userD);
    expect(summaryD.availableBalanceMinor).toBe('10000');

    // Check overview for User A
    const overviewA = await getReferralOverview(pool, userA);
    expect(overviewA.stats.level1Count).toBe(1);
    expect(overviewA.stats.totalCommissionsMinor).toBe('18000');
    expect(overviewA.commissions.length).toBe(4);
  });

  it('handles deposits and withdrawals with 0.5% fee accurately', async () => {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO users (username, email, phone_e164, password_hash, country_code, currency_code, locale, timezone, date_of_birth, referral_code)
       VALUES ('wallet_test_user', 'wallet@test.com', '+256700999888', 'hash', 'UG', 'UGX', 'en', 'Africa/Kampala', '2000-01-01', $1)
       RETURNING id`,
      [randomCode(8)],
    );
    const userId = Number(res.rows[0]!.id);

    // Deposit 100,000 UGX
    const dep = await recordDeposit(pool, userId, 100_000n, 'MTN Mobile Money', '+256700999888');
    expect(dep.newBalanceMinor).toBe('100000');

    const sum1 = await getWalletSummary(pool, userId);
    expect(sum1.availableBalanceMinor).toBe('100000');
    expect(sum1.totalDepositedMinor).toBe('100000');

    // Withdraw 20,000 UGX -> fee is 0.5% (100 UGX) -> deduction 20,100 -> remaining 79,900
    const wd = await requestWithdrawal(pool, userId, 20_000n, 'MTN Mobile Money', '+256700999888');
    expect(wd.feeMinor).toBe('100');
    expect(wd.newBalanceMinor).toBe('79900');

    const sum2 = await getWalletSummary(pool, userId);
    expect(sum2.availableBalanceMinor).toBe('79900');
    expect(sum2.totalWithdrawnMinor).toBe('20000');

    // Minimum withdrawal limit check (< 1000 fails)
    await expect(requestWithdrawal(pool, userId, 500n, 'MTN Mobile Money', '+256700999888')).rejects.toThrow(/Minimum withdrawal/);
  });

  it('completes tasks and credits the proper module and wallet balances', async () => {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO users (username, email, phone_e164, password_hash, country_code, currency_code, locale, timezone, date_of_birth, referral_code)
       VALUES ('task_test_user', 'task@test.com', '+256700777666', 'hash', 'UG', 'UGX', 'en', 'Africa/Kampala', '2000-01-01', $1)
       RETURNING id`,
      [randomCode(8)],
    );
    const userId = Number(res.rows[0]!.id);

    const ytTasks = await listTasks(pool, userId, 'youtube');
    expect(ytTasks.length).toBeGreaterThan(0);

    const firstTask = ytTasks[0]!;
    const completion = await completeTask(pool, userId, Number(firstTask.id), 'done');
    expect(completion.module).toBe('youtube');

    const summary = await getWalletSummary(pool, userId);
    expect(summary.availableBalanceMinor).toBe(firstTask.rewardMinor);
    expect(summary.taskBalancesMinor.youtube).toBe(firstTask.rewardMinor);
  });

  it('activates membership and distributes multi-level referral rewards', async () => {
    const create = async (username: string, referrerId: number | null) => {
      const res = await pool.query<{ id: string }>(
        `INSERT INTO users (username, email, phone_e164, password_hash, country_code, currency_code, locale, timezone, date_of_birth, referral_code, referred_by_user_id)
         VALUES ($1, $2, $3, 'hash', 'UG', 'UGX', 'en', 'Africa/Kampala', '2000-01-01', $4, $5)
         RETURNING id`,
        [username, `${username}@test.com`, `+256700${Math.floor(200000 + Math.random() * 700000)}`, randomCode(8), referrerId],
      );
      return Number(res.rows[0]!.id);
    };

    const referrer = await create('ref_boss', null);
    const member = await create('new_member', referrer);

    const act = await activateMembership(pool, member);
    expect(act.alreadyActive).toBe(false);
    expect(act.referralsRewarded).toBe(1);

    // Referrer received UGX 10,000 Level 1 reward
    const refWallet = await getWalletSummary(pool, referrer);
    expect(refWallet.availableBalanceMinor).toBe('10000');
  });
});
