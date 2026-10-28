import type { PoolClient } from '../../db/pool.js';
import { maybeOne, one, rows } from '../../db/sql.js';
import { badRequest, conflict } from '../../lib/errors.js';
import { currentCountryConfig } from '../countries/service.js';
import { accountId, balanceOf, InsufficientFundsError, move, post, type Leg } from '../ledger/ledger.js';
import { MAX_REFERRAL_LEVEL, payReferralReward, referralTiersUgx, UGANDA_FEE_UGX } from './service.js';

// An admin changes who invited a member (owner, 2026-10-26), and the referral rewards follow the new line:
// for the member and everyone up to two levels below them (whose level 2 and 3 rewards pass through the old
// line), each reward is recomputed against the new chain. A reward now due to someone else is taken back from
// its old receiver (from their balance; any part they already used becomes a debt, shown as a balance below
// zero) and paid to the new receiver from platform revenue. Rewards that still go to the same person stay.

export interface MovedReward {
  member: string;
  level: number;
  from: string | null;
  to: string | null;
  amountMinor: string;
  currency: string;
  debtMinor: string;
  // The old receiver's currency, which differs from `currency` when the reward was converted.
  debtCurrency: string;
}

interface Upline { id: number; username: string; currency: string; active: boolean }

async function uplineOf(db: PoolClient, userId: number): Promise<Upline[]> {
  const chain: Upline[] = [];
  let next = (await one<{ referred_by_user_id: string | null }>(db, 'SELECT referred_by_user_id FROM users WHERE id = $1', [userId])).referred_by_user_id;
  while (next && chain.length < MAX_REFERRAL_LEVEL) {
    const u = await one<{ id: string; username: string; currency_code: string; status: string; referred_by_user_id: string | null }>(
      db, 'SELECT id, username, currency_code, status, referred_by_user_id FROM users WHERE id = $1', [next],
    );
    chain.push({ id: Number(u.id), username: u.username, currency: u.currency_code, active: u.status === 'active' });
    next = u.referred_by_user_id;
  }
  return chain;
}

interface PaidReward {
  id: string;
  referrer_user_id: string;
  level: number;
  status: 'credited' | 'pending';
  amount_minor: string | null;
  currency_code: string;
  source_amount_minor: string | null;
  source_currency_code: string | null;
  receiver: string;
}

// Takes a reward back into platform revenue. A converted reward goes back the way it came, through fx_clearing,
// into the revenue of the currency that paid it. Returns the part that had to become a debt.
async function takeBack(db: PoolClient, reward: PaidReward, memo: string, refId: string, staffId: number): Promise<bigint> {
  const receiverId = Number(reward.referrer_user_id);
  const currency = reward.currency_code;
  const amount = BigInt(reward.amount_minor!);
  const converted = reward.source_currency_code !== null && reward.source_currency_code !== currency;
  const main = await accountId(db, { kind: 'member_main', userId: receiverId, currency });
  const debt = await accountId(db, { kind: 'member_debt', userId: receiverId, currency });
  const into = await accountId(db, { kind: converted ? 'fx_clearing' : 'platform_revenue', currency });
  const held = await balanceOf(db, main);
  const fromBalance = held < amount ? held : amount;
  const owed = amount - fromBalance;
  const legs: Leg[] = [];
  if (fromBalance > 0n) legs.push(...move(main, into, fromBalance));
  if (owed > 0n) legs.push(...move(debt, into, owed));
  if (converted) {
    const source = reward.source_currency_code!;
    legs.push(...move(await accountId(db, { kind: 'fx_clearing', currency: source }), await accountId(db, { kind: 'platform_revenue', currency: source }), BigInt(reward.source_amount_minor!)));
  }
  await post(db, { kind: 'referral_reversal', memo, refType: 'referral', refId, actorUserId: staffId, legs });
  return owed;
}

async function realign(db: PoolClient, rootId: number, staffId: number): Promise<MovedReward[]> {
  const affected = await rows<{ id: string; username: string; currency_code: string; country_code: string }>(
    db,
    `WITH RECURSIVE sub AS (
       SELECT id, 0 AS depth FROM users WHERE id = $1
       UNION ALL
       SELECT u.id, s.depth + 1 FROM users u JOIN sub s ON u.referred_by_user_id = s.id WHERE s.depth < ${MAX_REFERRAL_LEVEL - 1}
     )
     SELECT u.id, u.username, u.currency_code, u.country_code FROM sub JOIN users u ON u.id = sub.id
     WHERE EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id)
     ORDER BY sub.depth, u.id`,
    [rootId],
  );
  const tiers = await referralTiersUgx(db);
  const moved: MovedReward[] = [];
  for (const m of affected) {
    const memberId = Number(m.id);
    const chain = await uplineOf(db, memberId);
    const paid = await rows<PaidReward>(
      db,
      `SELECT r.id, r.referrer_user_id, r.level, r.status, r.amount_minor, r.currency_code, r.source_amount_minor, r.source_currency_code,
              u.username AS receiver
       FROM referral_rewards r JOIN users u ON u.id = r.referrer_user_id
       WHERE r.referred_user_id = $1 AND r.status IN ('credited', 'pending') FOR UPDATE OF r`,
      [memberId],
    );
    const config = await currentCountryConfig(db, m.country_code);
    const fee = config ? BigInt(config.membershipFeeMinor) : 0n;
    for (let level = 1; level <= MAX_REFERRAL_LEVEL; level++) {
      const due = chain[level - 1];
      const eligible = Boolean(due?.active);
      const current = paid.find(p => p.level === level);
      if (current && eligible && Number(current.referrer_user_id) === due!.id) continue;
      // The reward in this member's currency: what was paid (before any conversion), or the tier amount.
      const amount = current
        ? BigInt(current.source_amount_minor ?? current.amount_minor!)
        : ((tiers[level] ?? 0n) * fee) / UGANDA_FEE_UGX;
      if (amount <= 0n || (!current && !eligible)) continue;
      const refId = `REF-L${level}-${memberId}`;
      let owed = 0n;
      if (current?.status === 'pending') {
        await db.query(`UPDATE referral_rewards SET status = 'cancelled' WHERE id = $1`, [current.id]);
      } else if (current) {
        owed = await takeBack(db, current, `Level ${level} referral reward from @${m.username} moved after an inviter change`, refId, staffId);
        await db.query(`UPDATE referral_rewards SET status = 'reversed', reversed_at = now() WHERE id = $1`, [current.id]);
      }
      if (eligible) {
        await payReferralReward(db, {
          referrerId: due!.id, referrerCurrency: due!.currency, referredId: memberId, level, amountMinor: amount, currency: m.currency_code,
          memo: `Level ${level} referral reward from @${m.username} (inviter changed)`, actorUserId: staffId,
        });
      }
      moved.push({
        member: m.username, level, from: current?.receiver ?? null, to: eligible ? due!.username : null,
        amountMinor: amount.toString(), currency: m.currency_code, debtMinor: owed.toString(), debtCurrency: current?.currency_code ?? m.currency_code,
      });
    }
  }
  return moved;
}

export async function changeInviter(db: PoolClient, staffId: number, userId: number, username: string): Promise<{ before: string | null; after: string; moved: MovedReward[] }> {
  const user = await one<{ username: string; referred_by_user_id: string | null; inviter: string | null }>(
    db,
    `SELECT u.username, u.referred_by_user_id, r.username AS inviter FROM users u LEFT JOIN users r ON r.id = u.referred_by_user_id
     WHERE u.id = $1 FOR UPDATE OF u`,
    [userId],
  );
  const field = (message: string) => badRequest('validation_failed', message, { username: [message] });
  const next = await maybeOne<{ id: string; username: string }>(
    db, 'SELECT id, username FROM users WHERE username = $1 AND anonymized_at IS NULL', [username.trim().toLowerCase().replace(/^@/, '')],
  );
  if (!next) throw field('No member has that username.');
  const nextId = Number(next.id);
  if (nextId === userId) throw field('A member cannot invite themselves.');
  if (user.referred_by_user_id && Number(user.referred_by_user_id) === nextId) throw conflict('member.same_inviter', `@${next.username} already invited this member.`);
  // The new inviter must not be below this member, or the invite line would loop.
  let cursor: number | null = nextId;
  while (cursor !== null) {
    if (cursor === userId) throw field(`@${next.username} was invited (directly or further down) by this member, so they cannot be the inviter.`);
    const up: { referred_by_user_id: string | null } | null = await maybeOne(db, 'SELECT referred_by_user_id FROM users WHERE id = $1', [cursor]);
    cursor = up?.referred_by_user_id ? Number(up.referred_by_user_id) : null;
  }
  await db.query(`SELECT set_config('zentrix.admin_change', 'on', true)`);
  await db.query('UPDATE users SET referred_by_user_id = $2 WHERE id = $1', [userId, nextId]);
  try {
    return { before: user.inviter, after: next.username, moved: await realign(db, userId, staffId) };
  } catch (err) {
    if (err instanceof InsufficientFundsError) throw conflict('member.revenue_short', 'Platform revenue is too low to pay the new invite line. Nothing was changed.');
    throw err;
  }
}
