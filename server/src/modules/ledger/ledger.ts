import type { PoolClient } from '../../db/pool.js';
import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';
import { badRequest } from '../../lib/errors.js';

// The only module that writes ledger rows (section 5). Callers run inside a SERIALIZABLE transaction
// (moneyTx); post() locks every account it touches in ascending id order before writing.

export const TASK_MODULES = ['youtube', 'tiktok', 'ads', 'trivia', 'fixtap', 'music'] as const;
export type TaskModule = (typeof TASK_MODULES)[number];

export const SYSTEM_KINDS = [
  'platform_revenue', 'fees', 'referral_budget', 'promotions_budget', 'owner_capital', 'suspense', 'voucher_liability', 'fx_clearing',
] as const;
export type SystemKind = (typeof SYSTEM_KINDS)[number];

export type AccountRef =
  | { kind: 'member_main' | 'member_deposit' | 'member_withdrawal_hold' | 'member_debt'; userId: number; currency: string }
  | { kind: 'member_task'; userId: number; module: TaskModule; currency: string }
  | { kind: 'payment_clearing'; channelId: number; currency: string }
  | { kind: SystemKind; currency: string };

export interface Leg {
  account: number;
  side: 'debit' | 'credit';
  amountMinor: bigint;
}

export interface PostInput {
  kind: string;
  memo: string;
  refType?: string;
  refId?: string;
  actorUserId?: number | null;
  legs: Leg[];
}

// Finds or opens an account. Accounts always open at zero (database trigger).
export async function accountId(db: Db, ref: AccountRef): Promise<number> {
  const userId = 'userId' in ref ? ref.userId : null;
  const module = 'module' in ref ? ref.module : null;
  const channelId = 'channelId' in ref ? ref.channelId : null;
  const found = await maybeOne<{ id: string }>(
    db,
    `INSERT INTO accounts (kind, user_id, module, channel_id, currency_code) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (kind, user_id, module, channel_id, currency_code) DO NOTHING RETURNING id`,
    [ref.kind, userId, module, channelId, ref.currency],
  );
  if (found) return Number(found.id);
  const existing = await one<{ id: string }>(
    db,
    `SELECT id FROM accounts WHERE kind = $1 AND user_id IS NOT DISTINCT FROM $2 AND module IS NOT DISTINCT FROM $3
       AND channel_id IS NOT DISTINCT FROM $4 AND currency_code = $5`,
    [ref.kind, userId, module, channelId, ref.currency],
  );
  return Number(existing.id);
}

export async function balanceOf(db: Db, id: number): Promise<bigint> {
  const row = await one<{ balance_minor: string }>(db, 'SELECT balance_minor FROM accounts WHERE id = $1', [id]);
  return BigInt(row.balance_minor);
}

export class InsufficientFundsError extends Error {
  override name = 'InsufficientFundsError';
  constructor(readonly accountId: number, readonly accountKind: string) {
    super(`account ${accountId} (${accountKind}) has insufficient funds`);
  }
}

// Writes one balanced ledger transaction. Throws InsufficientFundsError before writing anything when a leg
// would take an account below zero; the database CHECK is the backstop.
export async function post(db: PoolClient, input: PostInput): Promise<number> {
  if (input.legs.length < 2) throw new Error('a ledger transaction needs at least two legs');
  for (const leg of input.legs) {
    if (typeof leg.amountMinor !== 'bigint' || leg.amountMinor <= 0n) throw new Error('ledger amounts must be positive bigints');
  }
  const ids = [...new Set(input.legs.map(l => l.account))].sort((a, b) => a - b);
  const locked = await rows<{ id: string; kind: string; currency_code: string; normal_side: string; balance_minor: string }>(
    db,
    'SELECT id, kind, currency_code, normal_side, balance_minor FROM accounts WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE',
    [ids],
  );
  if (locked.length !== ids.length) throw new Error('ledger leg refers to a missing account');
  const byId = new Map(locked.map(a => [Number(a.id), a]));

  const net = new Map<string, bigint>();
  const change = new Map<number, bigint>();
  for (const leg of input.legs) {
    const acc = byId.get(leg.account)!;
    const signed = leg.side === 'debit' ? leg.amountMinor : -leg.amountMinor;
    net.set(acc.currency_code, (net.get(acc.currency_code) ?? 0n) + signed);
    const delta = leg.side === acc.normal_side ? leg.amountMinor : -leg.amountMinor;
    change.set(leg.account, (change.get(leg.account) ?? 0n) + delta);
  }
  for (const [currency, sum] of net) {
    if (sum !== 0n) throw new Error(`ledger transaction does not balance in ${currency}`);
  }
  for (const [id, delta] of change) {
    const acc = byId.get(id)!;
    if (acc.kind !== 'fx_clearing' && BigInt(acc.balance_minor) + delta < 0n) throw new InsufficientFundsError(id, acc.kind);
  }

  const txn = await one<{ id: string }>(
    db,
    'INSERT INTO ledger_transactions (kind, memo, ref_type, ref_id, actor_user_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [input.kind, input.memo.slice(0, 300), input.refType ?? null, input.refId ?? null, input.actorUserId ?? null],
  );
  const values: unknown[] = [];
  const tuples = input.legs.map((leg, i) => {
    values.push(txn.id, leg.account, leg.side, leg.amountMinor.toString(), byId.get(leg.account)!.currency_code);
    const b = i * 5;
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`;
  });
  await db.query(`INSERT INTO ledger_entries (transaction_id, account_id, side, amount_minor, currency_code) VALUES ${tuples.join(', ')}`, values);
  return Number(txn.id);
}

// Two-leg shorthand: money moves from one account to another (debit `from`, credit `to` for credit-normal
// accounts; for cash held on a channel the sides follow the account's normal side).
export function move(from: number, to: number, amountMinor: bigint): Leg[] {
  return [
    { account: from, side: 'debit', amountMinor },
    { account: to, side: 'credit', amountMinor },
  ];
}

// Maps an InsufficientFundsError to the member-facing error; other errors pass through.
export function asMemberError(err: unknown, message = 'Your balance is too low for this.'): unknown {
  return err instanceof InsufficientFundsError ? badRequest('insufficient_funds', message) : err;
}
