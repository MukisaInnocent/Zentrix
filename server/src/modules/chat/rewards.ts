import type { PoolClient } from '../../db/pool.js';
import type { Db } from '../../db/sql.js';
import { maybeOne, one } from '../../db/sql.js';
import { badRequest, conflict, forbidden } from '../../lib/errors.js';
import { convert } from '../fx/service.js';
import { accountId, move, post } from '../ledger/ledger.js';
import { getSetting } from '../settings/registry.js';
import { findConversation } from './service.js';

// Chat with foreigners rewards (owner, 2026-11-06). Virtual money, not real yet: issued from task_credit into the
// member's 'chat' task balance, which cannot be withdrawn. Once per chat and member, after the member sent
// `minMessages` messages and the other member replied, at most `dailyLimit` claims per East Africa Time day.

export interface ChatReward {
  amountMinor: string;
  currency: string;
  claimed: boolean;
  claimable: boolean;
  // What is still missing, in words, when not claimable.
  needs: string | null;
}

async function rewardAmount(db: Db, amountUgx: number, currency: string): Promise<bigint | null> {
  if (amountUgx <= 0) return null;
  if (currency === 'UGX') return BigInt(amountUgx);
  const c = await convert(db, BigInt(amountUgx), 'UGX', currency);
  return c && c.amountMinor > 0n ? c.amountMinor : null;
}

export async function chatReward(db: Db, userId: number, conversation: { id: string; kind: string; other_id: number }): Promise<ChatReward | null> {
  if (conversation.kind !== 'foreign') return null;
  const rules = await getSetting(db, 'chat.foreign_reward');
  const member = await one<{ currency_code: string }>(db, 'SELECT currency_code FROM users WHERE id = $1', [userId]);
  const amount = await rewardAmount(db, rules.amountUgx, member.currency_code);
  if (amount === null) return null;
  const view = (claimed: boolean, needs: string | null): ChatReward => ({
    amountMinor: amount.toString(), currency: member.currency_code, claimed, claimable: !claimed && needs === null, needs,
  });
  if (await maybeOne(db, 'SELECT 1 FROM chat_reward_claims WHERE conversation_id = $1 AND user_id = $2', [conversation.id, userId])) return view(true, null);
  const counts = await one<{ mine: string; theirs: string }>(
    db,
    `SELECT count(*) FILTER (WHERE sender_user_id = $2) AS mine, count(*) FILTER (WHERE sender_user_id = $3) AS theirs
     FROM chat_messages WHERE conversation_id = $1`,
    [conversation.id, userId, conversation.other_id],
  );
  const left = rules.minMessages - Number(counts.mine);
  if (left > 0) return view(false, `Send ${left} more message${left === 1 ? '' : 's'} to claim.`);
  if (Number(counts.theirs) === 0) return view(false, 'Wait for a reply to claim.');
  const today = await one<{ n: string }>(
    db,
    `SELECT count(*) AS n FROM chat_reward_claims
     WHERE user_id = $1 AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala')`,
    [userId],
  );
  if (Number(today.n) >= rules.dailyLimit) return view(false, 'You have claimed the most chat rewards for today. Come back tomorrow.');
  return view(false, null);
}

// Runs inside the request's SERIALIZABLE transaction (idempotent()).
export async function claimChatReward(db: PoolClient, userId: number, publicId: string): Promise<ChatReward> {
  const c = await findConversation(db, userId, publicId);
  await db.query('SELECT id FROM chat_conversations WHERE id = $1 FOR UPDATE', [c.id]);
  if (c.kind !== 'foreign') throw badRequest('chat.no_reward', 'Only chats with foreigners earn a reward.');
  const blocked = await maybeOne(
    db, 'SELECT 1 FROM chat_blocks WHERE (blocker_user_id = $1 AND blocked_user_id = $2) OR (blocker_user_id = $2 AND blocked_user_id = $1)', [userId, c.other_id],
  );
  if (blocked) throw forbidden('chat.blocked', 'One of you has blocked the other.');
  const reward = await chatReward(db, userId, c);
  if (!reward) throw badRequest('chat.no_reward', 'Chat rewards are not available right now.');
  if (reward.claimed) throw conflict('chat.reward_claimed', 'You have already claimed the reward for this chat.');
  if (!reward.claimable) throw badRequest('chat.reward_not_ready', reward.needs ?? 'This reward cannot be claimed yet.');
  const amount = BigInt(reward.amountMinor);
  const credit = await accountId(db, { kind: 'task_credit', currency: reward.currency });
  const earnings = await accountId(db, { kind: 'member_task', userId, module: 'chat', currency: reward.currency });
  const txn = await post(db, {
    kind: 'chat_reward', memo: 'Chat with foreigners reward', refType: 'chat', refId: c.public_id, actorUserId: userId, legs: move(credit, earnings, amount),
  });
  await db.query(
    'INSERT INTO chat_reward_claims (conversation_id, user_id, amount_minor, currency_code, ledger_transaction_id) VALUES ($1, $2, $3, $4, $5)',
    [c.id, userId, amount.toString(), reward.currency, txn],
  );
  return { ...reward, claimed: true, claimable: false, needs: null };
}
