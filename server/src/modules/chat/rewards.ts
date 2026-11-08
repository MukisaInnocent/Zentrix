import type { PoolClient } from '../../db/pool.js';
import type { Db } from '../../db/sql.js';
import { maybeOne, one } from '../../db/sql.js';
import { badRequest, conflict } from '../../lib/errors.js';
import { convert } from '../fx/service.js';
import { accountId, move, post } from '../ledger/ledger.js';
import { getSetting } from '../settings/registry.js';

// Chat with foreigners daily reward (owner, 2026-11-08). Once per East Africa Time day: the member opens the live chat
// link (POST /api/chat/foreign/opened), then claims with the Claim reward button. Virtual money: issued from
// task_credit into the member's 'chat' task balance, which cannot be withdrawn (withdrawal.task_balance).

export interface DailyChatReward {
  amountMinor: string;
  currency: string;
  opened: boolean;
  claimed: boolean;
}

const TODAY = `(now() AT TIME ZONE 'Africa/Kampala')::date`;

async function rewardAmount(db: Db, amountUgx: number, currency: string): Promise<bigint | null> {
  if (amountUgx <= 0) return null;
  if (currency === 'UGX') return BigInt(amountUgx);
  const c = await convert(db, BigInt(amountUgx), 'UGX', currency);
  return c && c.amountMinor > 0n ? c.amountMinor : null;
}

// Today's reward for the member, or null when rewards are off (amount 0) or the currency has no rate yet.
export async function dailyChatReward(db: Db, userId: number): Promise<DailyChatReward | null> {
  const rules = await getSetting(db, 'chat.foreign_reward');
  const member = await one<{ currency_code: string }>(db, 'SELECT currency_code FROM users WHERE id = $1', [userId]);
  const amount = await rewardAmount(db, rules.amountUgx, member.currency_code);
  if (amount === null) return null;
  const row = await maybeOne<{ claimed_at: Date | null; amount_minor: string | null; currency_code: string | null }>(
    db, `SELECT claimed_at, amount_minor, currency_code FROM chat_daily_rewards WHERE user_id = $1 AND day = ${TODAY}`, [userId],
  );
  if (row?.claimed_at) return { amountMinor: String(row.amount_minor), currency: String(row.currency_code), opened: true, claimed: true };
  return { amountMinor: amount.toString(), currency: member.currency_code, opened: row !== null, claimed: false };
}

export async function recordChatOpened(db: Db, userId: number): Promise<void> {
  await db.query(`INSERT INTO chat_daily_rewards (user_id, day) VALUES ($1, ${TODAY}) ON CONFLICT DO NOTHING`, [userId]);
}

// Runs inside the request's SERIALIZABLE transaction (idempotent()).
export async function claimDailyChatReward(db: PoolClient, userId: number): Promise<DailyChatReward> {
  const reward = await dailyChatReward(db, userId);
  if (!reward) throw badRequest('chat.no_reward', 'Chat rewards are not available right now.');
  const row = await maybeOne<{ claimed_at: Date | null }>(
    db, `SELECT claimed_at FROM chat_daily_rewards WHERE user_id = $1 AND day = ${TODAY} FOR UPDATE`, [userId],
  );
  if (!row) throw badRequest('chat.open_link_first', 'Open the live chat link first, then claim your reward.');
  if (row.claimed_at) throw conflict('chat.reward_claimed', 'You have claimed today\'s reward. Come back tomorrow.');
  const amount = BigInt(reward.amountMinor);
  const credit = await accountId(db, { kind: 'task_credit', currency: reward.currency });
  const earnings = await accountId(db, { kind: 'member_task', userId, module: 'chat', currency: reward.currency });
  const txn = await post(db, {
    kind: 'chat_reward', memo: 'Chat with foreigners daily reward', refType: 'chat', refId: `daily-${userId}`, actorUserId: userId, legs: move(credit, earnings, amount),
  });
  await db.query(
    `UPDATE chat_daily_rewards SET claimed_at = now(), amount_minor = $2, currency_code = $3, ledger_transaction_id = $4 WHERE user_id = $1 AND day = ${TODAY}`,
    [userId, amount.toString(), reward.currency, txn],
  );
  return { ...reward, opened: true, claimed: true };
}
