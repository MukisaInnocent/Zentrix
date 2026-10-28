import type { Pool, PoolClient } from '../../db/pool.js';
import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';
import { withTransaction } from '../../db/tx.js';
import { currentCountryConfig } from '../countries/service.js';
import { convert } from '../fx/service.js';
import { accountId, move, post } from '../ledger/ledger.js';
import { getSetting } from '../settings/registry.js';
import { settleDebt } from '../wallet/service.js';

// Referral rewards (owner decision: levels 1 to 3, left as the owner built them). The amounts are the Uganda
// ones, set by an admin in the `referral.tier_amounts_ugx` setting (UGX 10,000 / 5,000 / 2,000 until changed);
// for another country each amount is scaled by that country's activation fee against UGX 19,000, so the
// reward is the same share of the fee everywhere (TODO(owner): confirm). Rewards are paid from platform revenue
// when the invited member's activation fee is confirmed, never at sign-up. A referrer in another country receives
// the reward converted into their own currency at the latest exchange rate (owner, 2026-10-28).
export async function referralTiersUgx(db: Db): Promise<Record<number, bigint>> {
  const t = await getSetting(db, 'referral.tier_amounts_ugx');
  return { 1: BigInt(t.level1), 2: BigInt(t.level2), 3: BigInt(t.level3) };
}

/** Referral rewards stop at level 3. Nothing is paid above this level. */
export const MAX_REFERRAL_LEVEL = 3;
export const UGANDA_FEE_UGX = 19_000n;

export interface LevelCounts {
  total: number;
  active: number;
  inactive: number;
  // Referral rewards credited to the user from this level.
  rewardsMinor: string;
}

export interface ReferralOverview {
  username: string;
  upline: { username: string } | null;
  currency: string;
  totalRewardsMinor: string;
  levels: Record<1 | 2 | 3, LevelCounts>;
  tierAmounts: { level: number; amountMinor: string }[];
}

export interface ReferralMember {
  username: string;
  // Shown to the people above them in the referral pages (owner, 2026-10-26).
  phone: string | null;
  country: string;
  level: number;
  joinedAt: Date;
  status: 'Active' | 'Inactive';
  activatedAt: Date | null;
  rewardMinor: string;
  currency: string;
  // The referrer's own currency: rewards from another country arrive converted.
  rewardCurrency: string;
}

export interface RewardPayment {
  referrerId: number;
  referrerCurrency: string;
  referredId: number;
  level: number;
  // The reward in the invited member's currency.
  amountMinor: bigint;
  currency: string;
  memo: string;
  actorUserId?: number | null;
  // Set when paying a reward that was waiting for an exchange rate.
  pendingId?: string;
}

// Pays one referral reward from platform revenue in the invited member's currency. A referrer in another currency
// receives it converted at the latest exchange rate (owner, 2026-10-28), through fx_clearing in both currencies.
// Without a recent rate the reward waits as 'pending' and the exchange-rate job pays it after the next refresh.
export async function payReferralReward(db: PoolClient, r: RewardPayment): Promise<'credited' | 'pending' | 'cancelled'> {
  const fx = r.referrerCurrency === r.currency ? null : await convert(db, r.amountMinor, r.currency, r.referrerCurrency);
  if (r.referrerCurrency !== r.currency && !fx) {
    if (!r.pendingId) {
      await db.query(
        `INSERT INTO referral_rewards (referrer_user_id, referred_user_id, level, amount_minor, currency_code, source_amount_minor, source_currency_code, status)
         VALUES ($1, $2, $3, NULL, $4, $5, $6, 'pending')`,
        [r.referrerId, r.referredId, r.level, r.referrerCurrency, r.amountMinor.toString(), r.currency],
      );
    }
    return 'pending';
  }
  const credited = fx ? fx.amountMinor : r.amountMinor;
  if (credited <= 0n) {
    if (r.pendingId) await db.query(`UPDATE referral_rewards SET status = 'cancelled' WHERE id = $1`, [r.pendingId]);
    return 'cancelled';
  }
  const revenue = await accountId(db, { kind: 'platform_revenue', currency: r.currency });
  const main = await accountId(db, { kind: 'member_main', userId: r.referrerId, currency: r.referrerCurrency });
  const legs = fx
    ? [
        ...move(revenue, await accountId(db, { kind: 'fx_clearing', currency: r.currency }), r.amountMinor),
        ...move(await accountId(db, { kind: 'fx_clearing', currency: r.referrerCurrency }), main, credited),
      ]
    : move(revenue, main, credited);
  await post(db, {
    kind: 'referral_bonus',
    memo: fx ? `${r.memo} (converted from ${r.currency} at ${fx.rate})` : r.memo,
    refType: 'referral',
    refId: `REF-L${r.level}-${r.referredId}`,
    actorUserId: r.actorUserId ?? null,
    legs,
  });
  const source = fx ? [r.amountMinor.toString(), r.currency, fx.rate, fx.rateAt] : [null, null, null, null];
  if (r.pendingId) {
    await db.query(
      `UPDATE referral_rewards SET status = 'credited', amount_minor = $2, fx_rate = $3, fx_rate_at = $4 WHERE id = $1 AND status = 'pending'`,
      [r.pendingId, credited.toString(), source[2], source[3]],
    );
  } else {
    await db.query(
      `INSERT INTO referral_rewards (referrer_user_id, referred_user_id, level, amount_minor, currency_code, source_amount_minor, source_currency_code, fx_rate, fx_rate_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'credited')`,
      [r.referrerId, r.referredId, r.level, credited.toString(), r.referrerCurrency, ...source],
    );
  }
  await settleDebt(db, r.referrerId, r.referrerCurrency);
  return 'credited';
}

// Pays the rewards that were waiting for an exchange rate, one transaction each. Returns how many were paid.
export async function payPendingReferralRewards(pool: Pool): Promise<number> {
  const ids = await rows<{ id: string }>(pool, `SELECT id FROM referral_rewards WHERE status = 'pending' AND source_amount_minor IS NOT NULL ORDER BY id`, []);
  let paid = 0;
  for (const { id } of ids) {
    const outcome = await withTransaction(pool, async db => {
      const r = await maybeOne<{ referrer_user_id: string; referred_user_id: string; level: number; currency_code: string; source_amount_minor: string; source_currency_code: string; username: string }>(
        db,
        `SELECT r.referrer_user_id, r.referred_user_id, r.level, r.currency_code, r.source_amount_minor, r.source_currency_code, u.username
         FROM referral_rewards r JOIN users u ON u.id = r.referred_user_id WHERE r.id = $1 AND r.status = 'pending' FOR UPDATE OF r`,
        [id],
      );
      if (!r) return 'gone';
      return payReferralReward(db, {
        referrerId: Number(r.referrer_user_id), referrerCurrency: r.currency_code, referredId: Number(r.referred_user_id), level: r.level,
        amountMinor: BigInt(r.source_amount_minor), currency: r.source_currency_code, memo: `Level ${r.level} referral reward from @${r.username}`, pendingId: id,
      });
    }, { isolation: 'serializable' });
    if (outcome === 'credited') paid++;
  }
  return paid;
}

// Pays the people above a newly activated member: level 1 the direct referrer, level 2 their referrer, level 3
// the next one up. A referrer in another country is paid in their own currency (payReferralReward).
export async function distributeReferralRewards(
  db: PoolClient,
  newUserId: number,
): Promise<{ distributedCount: number; totalDistributedMinor: bigint }> {
  const none = { distributedCount: 0, totalDistributedMinor: 0n };
  if (await maybeOne(db, 'SELECT 1 FROM referral_rewards WHERE referred_user_id = $1', [newUserId])) return none;
  if (!(await maybeOne(db, 'SELECT 1 FROM memberships WHERE user_id = $1', [newUserId]))) return none;

  const newUser = await maybeOne<{ id: string; username: string; referred_by_user_id: string | null; currency_code: string; country_code: string }>(
    db, 'SELECT id, username, referred_by_user_id, currency_code, country_code FROM users WHERE id = $1', [newUserId],
  );
  if (!newUser?.referred_by_user_id) return none;
  const config = await currentCountryConfig(db, newUser.country_code);
  if (!config) return none;
  const fee = BigInt(config.membershipFeeMinor);
  const tiers = await referralTiersUgx(db);

  let currentReferrerId: number | null = Number(newUser.referred_by_user_id);
  let distributedCount = 0;
  let totalDistributedMinor = 0n;
  for (let level = 1; currentReferrerId !== null && level <= MAX_REFERRAL_LEVEL; level++) {
    const tier = tiers[level];
    const referrer: { currency_code: string; status: string; referred_by_user_id: string | null } | null = await maybeOne(
      db, 'SELECT currency_code, status, referred_by_user_id FROM users WHERE id = $1', [currentReferrerId],
    );
    if (!referrer || tier === undefined) break;
    const rewardMinor = (tier * fee) / UGANDA_FEE_UGX;
    if (rewardMinor > 0n && referrer.status === 'active') {
      const outcome = await payReferralReward(db, {
        referrerId: currentReferrerId, referrerCurrency: referrer.currency_code, referredId: newUserId, level,
        amountMinor: rewardMinor, currency: newUser.currency_code, memo: `Level ${level} referral reward from @${newUser.username}`,
      });
      if (outcome !== 'cancelled') {
        distributedCount++;
        totalDistributedMinor += rewardMinor;
      }
    }
    currentReferrerId = referrer.referred_by_user_id ? Number(referrer.referred_by_user_id) : null;
  }
  return { distributedCount, totalDistributedMinor };
}

const TREE = `
  WITH RECURSIVE tree AS (
    SELECT id, 1 AS level FROM users WHERE referred_by_user_id = $1
    UNION ALL
    SELECT u.id, t.level + 1 FROM users u JOIN tree t ON u.referred_by_user_id = t.id WHERE t.level < ${MAX_REFERRAL_LEVEL}
  )`;

export async function getReferralOverview(db: Db, userId: number): Promise<ReferralOverview> {
  const user = await one<{ username: string; currency_code: string; country_code: string; upline: string | null }>(
    db,
    `SELECT u.username, u.currency_code, u.country_code, r.username AS upline FROM users u LEFT JOIN users r ON r.id = u.referred_by_user_id WHERE u.id = $1`,
    [userId],
  );
  const counts = await rows<{ level: number; total: string; active: string }>(
    db,
    `${TREE} SELECT t.level, count(*) AS total, count(m.user_id) AS active FROM tree t LEFT JOIN memberships m ON m.user_id = t.id GROUP BY t.level`,
    [userId],
  );
  const rewards = await rows<{ level: number; credited: string }>(
    db, `SELECT level, sum(amount_minor)::text AS credited FROM referral_rewards WHERE referrer_user_id = $1 AND status = 'credited' GROUP BY level`, [userId],
  );
  const config = await currentCountryConfig(db, user.country_code);
  const fee = config ? BigInt(config.membershipFeeMinor) : 0n;
  const rewardsAt = (level: number) => rewards.find(r => r.level === level)?.credited ?? '0';
  const levels = {} as ReferralOverview['levels'];
  for (const level of [1, 2, 3] as const) {
    const c = counts.find(x => x.level === level);
    const total = Number(c?.total ?? 0);
    const active = Number(c?.active ?? 0);
    levels[level] = { total, active, inactive: total - active, rewardsMinor: rewardsAt(level) };
  }
  return {
    username: user.username,
    upline: user.upline ? { username: user.upline } : null,
    currency: user.currency_code,
    totalRewardsMinor: rewards.reduce((sum, r) => sum + BigInt(r.credited), 0n).toString(),
    levels,
    tierAmounts: Object.entries(await referralTiersUgx(db)).map(([level, tier]) => ({ level: Number(level), amountMinor: ((tier * fee) / UGANDA_FEE_UGX).toString() })),
  };
}

// The members at one level below the user, optionally only the activated or the not-yet-activated ones.
export async function listReferralMembers(db: Db, userId: number, level: number, status: 'all' | 'active' | 'inactive'): Promise<ReferralMember[]> {
  const list = await rows<{
    username: string; phone_e164: string | null; country_code: string; created_at: Date; level: number; activated_at: Date | null; reward: string; currency_code: string; reward_currency: string;
  }>(
    db,
    `${TREE}
     SELECT u.username, u.phone_e164, u.country_code, u.created_at, t.level, m.activated_at, u.currency_code,
            (SELECT currency_code FROM users WHERE id = $1) AS reward_currency,
            coalesce((SELECT sum(r.amount_minor) FROM referral_rewards r
                      WHERE r.referrer_user_id = $1 AND r.referred_user_id = u.id AND r.status = 'credited'), 0)::text AS reward
     FROM tree t JOIN users u ON u.id = t.id LEFT JOIN memberships m ON m.user_id = u.id
     WHERE t.level = $2 AND ($3 = 'all' OR ($3 = 'active') = (m.user_id IS NOT NULL))
     ORDER BY u.created_at DESC LIMIT 500`,
    [userId, level, status],
  );
  return list.map(r => ({
    username: r.username, phone: r.phone_e164, country: r.country_code, level: r.level, joinedAt: r.created_at, status: r.activated_at ? 'Active' : 'Inactive',
    activatedAt: r.activated_at, rewardMinor: r.reward, currency: r.currency_code, rewardCurrency: r.reward_currency,
  }));
}

export type LeaderPeriod = 'all' | '30d' | '7d';

export interface ReferralLeader {
  rank: number;
  userId: number;
  username: string;
  phone: string | null;
  country: string;
  invited: number;
  activated: number;
  rewardsMinor: string;
  currency: string;
}

// Members ranked by the people they invited directly who activated (owner, 2026-10-26). Staff and system accounts,
// superadmin included, are left out. Ranking pays no prize (rule 3.3). `period` is one of three fixed values.
export async function referralLeaders(db: Db, period: LeaderPeriod, limit: number): Promise<ReferralLeader[]> {
  const since = period === '30d' ? "now() - interval '30 days'" : period === '7d' ? "now() - interval '7 days'" : "'-infinity'::timestamptz";
  const list = await rows<{ id: string; username: string; phone_e164: string | null; country_code: string; currency_code: string; invited: string; activated: string; rewards: string }>(
    db,
    `SELECT u.id, u.username, u.phone_e164, u.country_code, u.currency_code,
            count(i.id) FILTER (WHERE i.created_at > ${since}) AS invited,
            count(m.user_id) FILTER (WHERE m.activated_at > ${since}) AS activated,
            coalesce((SELECT sum(r.amount_minor) FROM referral_rewards r WHERE r.referrer_user_id = u.id AND r.status = 'credited' AND r.created_at > ${since}), 0)::text AS rewards
     FROM users u
     JOIN users i ON i.referred_by_user_id = u.id
     LEFT JOIN memberships m ON m.user_id = i.id
     WHERE u.anonymized_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM user_roles ur JOIN roles ro ON ro.name = ur.role WHERE ur.user_id = u.id AND ro.is_staff)
     GROUP BY u.id
     HAVING count(i.id) FILTER (WHERE i.created_at > ${since}) > 0
     ORDER BY activated DESC, invited DESC, rewards DESC, u.username
     LIMIT $1`,
    [limit],
  );
  return list.map((l, i) => ({
    rank: i + 1, userId: Number(l.id), username: l.username, phone: l.phone_e164, country: l.country_code,
    invited: Number(l.invited), activated: Number(l.activated), rewardsMinor: l.rewards, currency: l.currency_code,
  }));
}
