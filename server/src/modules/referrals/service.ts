import type { PoolClient } from '../../db/pool.js';
import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';
import { currentCountryConfig } from '../countries/service.js';
import { accountId, move, post } from '../ledger/ledger.js';

// Referral rewards (owner decision: levels 1 to 3, left as the owner built them). The amounts are the Uganda
// ones; for another country each amount is scaled by that country's activation fee against UGX 19,000, so the
// reward is the same share of the fee everywhere (TODO(owner): confirm). Rewards are paid from platform revenue
// when the invited member's activation fee is confirmed, never at sign-up.
export const REFERRAL_TIERS_UGX: Record<number, bigint> = {
  1: 10_000n, // Level 1 (direct referrer)
  2: 5_000n, // Level 2 (referrer of referrer)
  3: 2_000n, // Level 3
};

/** Referral rewards stop at level 3. Nothing is paid above this level. */
export const MAX_REFERRAL_LEVEL = 3;
const UGANDA_FEE_UGX = 19_000n;

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
  country: string;
  level: number;
  joinedAt: Date;
  status: 'Active' | 'Inactive';
  activatedAt: Date | null;
  rewardMinor: string;
  currency: string;
}

// Pays the people above a newly activated member: level 1 the direct referrer, level 2 their referrer, level 3
// the next one up. A level whose referrer uses a different currency is skipped (no implicit conversion).
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

  let currentReferrerId: number | null = Number(newUser.referred_by_user_id);
  let distributedCount = 0;
  let totalDistributedMinor = 0n;
  for (let level = 1; currentReferrerId !== null && level <= MAX_REFERRAL_LEVEL; level++) {
    const tier = REFERRAL_TIERS_UGX[level];
    const referrer: { currency_code: string; status: string; referred_by_user_id: string | null } | null = await maybeOne(
      db, 'SELECT currency_code, status, referred_by_user_id FROM users WHERE id = $1', [currentReferrerId],
    );
    if (!referrer || tier === undefined) break;
    const rewardMinor = (tier * fee) / UGANDA_FEE_UGX;
    if (rewardMinor > 0n && referrer.currency_code === newUser.currency_code && referrer.status === 'active') {
      const revenue = await accountId(db, { kind: 'platform_revenue', currency: newUser.currency_code });
      const referrerMain = await accountId(db, { kind: 'member_main', userId: currentReferrerId, currency: newUser.currency_code });
      await post(db, {
        kind: 'referral_bonus',
        memo: `Level ${level} referral reward from @${newUser.username}`,
        refType: 'referral',
        refId: `REF-L${level}-${newUser.id}`,
        legs: move(revenue, referrerMain, rewardMinor),
      });
      await db.query(
        `INSERT INTO referral_rewards (referrer_user_id, referred_user_id, level, amount_minor, currency_code, status)
         VALUES ($1, $2, $3, $4, $5, 'credited')`,
        [currentReferrerId, newUserId, level, rewardMinor.toString(), newUser.currency_code],
      );
      distributedCount++;
      totalDistributedMinor += rewardMinor;
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
    tierAmounts: Object.entries(REFERRAL_TIERS_UGX).map(([level, tier]) => ({ level: Number(level), amountMinor: ((tier * fee) / UGANDA_FEE_UGX).toString() })),
  };
}

// The members at one level below the user, optionally only the activated or the not-yet-activated ones.
export async function listReferralMembers(db: Db, userId: number, level: number, status: 'all' | 'active' | 'inactive'): Promise<ReferralMember[]> {
  const list = await rows<{
    username: string; country_code: string; created_at: Date; level: number; activated_at: Date | null; reward: string; currency_code: string;
  }>(
    db,
    `${TREE}
     SELECT u.username, u.country_code, u.created_at, t.level, m.activated_at, u.currency_code,
            coalesce((SELECT sum(r.amount_minor) FROM referral_rewards r
                      WHERE r.referrer_user_id = $1 AND r.referred_user_id = u.id AND r.status = 'credited'), 0)::text AS reward
     FROM tree t JOIN users u ON u.id = t.id LEFT JOIN memberships m ON m.user_id = u.id
     WHERE t.level = $2 AND ($3 = 'all' OR ($3 = 'active') = (m.user_id IS NOT NULL))
     ORDER BY u.created_at DESC LIMIT 500`,
    [userId, level, status],
  );
  return list.map(r => ({
    username: r.username, country: r.country_code, level: r.level, joinedAt: r.created_at, status: r.activated_at ? 'Active' : 'Inactive',
    activatedAt: r.activated_at, rewardMinor: r.reward, currency: r.currency_code,
  }));
}
