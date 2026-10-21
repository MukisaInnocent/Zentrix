import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';

export const REFERRAL_TIERS_UGX: Record<number, bigint> = {
  1: 10_000n, // Level 1 (Direct referrer): UGX 10,000
  2: 5_000n,  // Level 2 (Referrer of referrer): UGX 5,000
  3: 2_000n,  // Level 3 (Third level): UGX 2,000
  4: 1_000n,  // Level 4: UGX 1,000
  5: 500n,    // Level 5: UGX 500
};

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
}

/**
 * Distributes multi-level referral rewards up the sponsor hierarchy for a user.
 * Level 1: UGX 10,000
 * Level 2: UGX 5,000
 * Level 3: UGX 2,000
 * Level 4: UGX 1,000
 * Level 5: UGX 500
 */
export async function distributeReferralRewards(
  db: Db,
  newUserId: number,
): Promise<{ distributedCount: number; totalDistributedMinor: bigint }> {
  // Check if rewards were already distributed for this user
  const already = await maybeOne(db, 'SELECT 1 FROM referral_rewards WHERE referred_user_id = $1', [newUserId]);
  if (already) return { distributedCount: 0, totalDistributedMinor: 0n };

  const newUser = await maybeOne<{ id: string; username: string; referred_by_user_id: string | null; currency_code: string }>(
    db,
    'SELECT id, username, referred_by_user_id, currency_code FROM users WHERE id = $1',
    [newUserId],
  );
  if (!newUser || !newUser.referred_by_user_id) return { distributedCount: 0, totalDistributedMinor: 0n };

  let currentReferrerId: number | null = Number(newUser.referred_by_user_id);
  let level = 1;
  let distributedCount = 0;
  let totalDistributedMinor = 0n;

  while (currentReferrerId && level <= 5) {
    const rewardMinor = REFERRAL_TIERS_UGX[level] ?? 500n;

    // Record the commission in referral_rewards
    await db.query(
      `INSERT INTO referral_rewards (referrer_user_id, referred_user_id, level, amount_minor, currency_code, status)
       VALUES ($1, $2, $3, $4, 'UGX', 'credited')`,
      [currentReferrerId, newUserId, level, rewardMinor.toString()],
    );

    // Update referrer's wallet
    const updatedWallet = await one<{ balance_minor: string }>(
      db,
      `UPDATE wallets
       SET balance_minor = balance_minor + $1,
           total_referral_earned_minor = total_referral_earned_minor + $1,
           updated_at = now()
       WHERE user_id = $2
       RETURNING balance_minor`,
      [rewardMinor.toString(), currentReferrerId],
    );

    // Record in wallet_transactions
    await db.query(
      `INSERT INTO wallet_transactions (user_id, kind, amount_minor, currency_code, balance_after_minor, description, reference)
       VALUES ($1, 'referral_bonus', $2, 'UGX', $3, $4, $5)`,
      [
        currentReferrerId,
        rewardMinor.toString(),
        updatedWallet.balance_minor,
        `Level ${level} referral commission from @${newUser.username}`,
        `REF-L${level}-${newUser.id}`,
      ],
    );

    distributedCount++;
    totalDistributedMinor += rewardMinor;

    // Move to next upstream referrer in the chain
    const referrer: { referred_by_user_id: string | null } | null = await maybeOne<{ referred_by_user_id: string | null }>(
      db,
      'SELECT referred_by_user_id FROM users WHERE id = $1',
      [currentReferrerId],
    );
    currentReferrerId = referrer?.referred_by_user_id ? Number(referrer.referred_by_user_id) : null;
    level++;
  }

  return { distributedCount, totalDistributedMinor };
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
    'SELECT coalesce(sum(amount_minor), 0)::text AS total FROM referral_rewards WHERE referrer_user_id = $1',
    [userId],
  );

  const rawCommissions = await rows<{
    id: string;
    level: number;
    amount_minor: string;
    currency_code: string;
    created_at: Date;
    from_username: string;
  }>(
    db,
    `SELECT r.id, r.level, r.amount_minor, r.currency_code, r.created_at, u.username AS from_username
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
  }));

  const stats: ReferralStat = {
    referralCode: user.referral_code,
    totalReferrals: team.length,
    totalCommissionsMinor: totalCommissions.total,
    currency: 'UGX',
    level1Count: level1Users.length,
    level2Count: level2Users.length,
    level3Count: level3Users.length,
    tierAmounts: [
      { level: 1, amount: '10000' },
      { level: 2, amount: '5000' },
      { level: 3, amount: '2000' },
      { level: 4, amount: '1000' },
      { level: 5, amount: '500' },
    ],
  };

  return { stats, team, commissions };
}
