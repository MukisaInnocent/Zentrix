import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';

// Single level, flat amount (rules 3.1 and 3.2). The owner asked for UGX 10,000 / 5,000 / 2,000 over three
// levels; that is a multi-level commission, so it is not built. Until the owner picks a single-level amount
// within the 10% cap (UGX 1,900 of the UGX 19,000 fee), the plan's default UGX 1,000 applies: TODO(owner).
// Rewards are recorded as pending and nothing is paid until the release flow from referral_budget exists.
export const REFERRAL_REWARD_MINOR: Record<string, bigint> = { UGX: 1_000n };

export interface ReferralStat {
  referralCode: string;
  totalReferrals: number;
  totalCommissionsMinor: string;
  currency: string;
  level1Count: number;
  level2Count: number;
  level3Count: number;
  tierAmounts: { level: number; amount: string }[];
}

export interface TeamMember {
  id: string;
  username: string;
  country: string;
  level: number;
  joinedAt: Date;
  status: 'Active' | 'Pending';
}

export interface CommissionItem {
  id: string;
  date: Date;
  fromUsername: string;
  level: number;
  amountMinor: string;
  currency: string;
  status: string;
}

// Records the direct referrer's reward when a referred member pays the membership fee. No money moves here:
// the reward stays pending (hold period, caps and the referral_budget payout come with Phase 4).
export async function recordReferralReward(db: Db, referredUserId: number): Promise<boolean> {
  const user = await maybeOne<{ referred_by_user_id: string | null; currency_code: string }>(
    db, 'SELECT referred_by_user_id, currency_code FROM users WHERE id = $1', [referredUserId],
  );
  const amount = user ? REFERRAL_REWARD_MINOR[user.currency_code] : undefined;
  if (!user?.referred_by_user_id || amount === undefined) return false;
  if (await maybeOne(db, 'SELECT 1 FROM referral_rewards WHERE referred_user_id = $1', [referredUserId])) return false;
  await db.query(
    `INSERT INTO referral_rewards (referrer_user_id, referred_user_id, level, amount_minor, currency_code, status)
     VALUES ($1, $2, 1, $3, $4, 'pending')`,
    [user.referred_by_user_id, referredUserId, amount.toString(), user.currency_code],
  );
  return true;
}

/**
 * Loads referral team statistics and multi-level hierarchy for a user.
 */
export async function getReferralOverview(
  db: Db,
  userId: number,
): Promise<{
  stats: ReferralStat;
  team: TeamMember[];
  commissions: CommissionItem[];
}> {
  const user = await one<{ referral_code: string; currency_code: string }>(
    db,
    'SELECT referral_code, currency_code FROM users WHERE id = $1',
    [userId],
  );

  // Level 1: direct
  const level1Users = await rows<{ id: string; username: string; country_code: string; created_at: Date }>(
    db,
    'SELECT id, username, country_code, created_at FROM users WHERE referred_by_user_id = $1 ORDER BY created_at DESC',
    [userId],
  );

  const level1Ids = level1Users.map(u => Number(u.id));

  // Level 2: referred by level 1
  let level2Users: { id: string; username: string; country_code: string; created_at: Date }[] = [];
  if (level1Ids.length > 0) {
    level2Users = await rows<{ id: string; username: string; country_code: string; created_at: Date }>(
      db,
      'SELECT id, username, country_code, created_at FROM users WHERE referred_by_user_id = ANY($1) ORDER BY created_at DESC',
      [level1Ids],
    );
  }

  const level2Ids = level2Users.map(u => Number(u.id));

  // Level 3: referred by level 2
  let level3Users: { id: string; username: string; country_code: string; created_at: Date }[] = [];
  if (level2Ids.length > 0) {
    level3Users = await rows<{ id: string; username: string; country_code: string; created_at: Date }>(
      db,
      'SELECT id, username, country_code, created_at FROM users WHERE referred_by_user_id = ANY($1) ORDER BY created_at DESC',
      [level2Ids],
    );
  }

  const team: TeamMember[] = [
    ...level1Users.map(u => ({ id: u.id, username: u.username, country: u.country_code, level: 1, joinedAt: u.created_at, status: 'Active' as const })),
    ...level2Users.map(u => ({ id: u.id, username: u.username, country: u.country_code, level: 2, joinedAt: u.created_at, status: 'Active' as const })),
    ...level3Users.map(u => ({ id: u.id, username: u.username, country: u.country_code, level: 3, joinedAt: u.created_at, status: 'Active' as const })),
  ];

  const totalCommissions = await one<{ total: string }>(
    db,
    `SELECT coalesce(sum(amount_minor), 0)::text AS total FROM referral_rewards WHERE referrer_user_id = $1 AND status = 'credited'`,
    [userId],
  );

  const rawCommissions = await rows<{
    id: string;
    level: number;
    amount_minor: string;
    currency_code: string;
    status: string;
    created_at: Date;
    from_username: string;
  }>(
    db,
    `SELECT r.id, r.level, r.amount_minor, r.currency_code, r.status, r.created_at, u.username AS from_username
     FROM referral_rewards r
     JOIN users u ON u.id = r.referred_user_id
     WHERE r.referrer_user_id = $1
     ORDER BY r.created_at DESC LIMIT 50`,
    [userId],
  );

  const commissions: CommissionItem[] = rawCommissions.map(c => ({
    id: c.id,
    date: c.created_at,
    fromUsername: c.from_username,
    level: c.level,
    amountMinor: c.amount_minor,
    currency: c.currency_code,
    status: c.status,
  }));

  const stats: ReferralStat = {
    referralCode: user.referral_code,
    totalReferrals: team.length,
    totalCommissionsMinor: totalCommissions.total,
    currency: 'UGX',
    level1Count: level1Users.length,
    level2Count: level2Users.length,
    level3Count: level3Users.length,
    tierAmounts: [{ level: 1, amount: String(REFERRAL_REWARD_MINOR[user.currency_code] ?? 0n) }],
  };

  return { stats, team, commissions };
}
