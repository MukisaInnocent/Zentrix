import type { PoolClient } from '../../db/pool.js';
import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { accountId, InsufficientFundsError, move, post } from '../ledger/ledger.js';
import { channelByCode, normalizeTxnId } from './common.js';

// Platform money moves, each requested by one staff member and approved by a different admin before the ledger
// moves (maker-checker). None of them touch member balances:
//   capital_in        owner puts money on a channel        channel cash  -> owner_capital
//   owner_withdrawal  owner takes revenue or capital out   revenue/fees/capital -> channel cash
//   fund_budget       budget for task rewards or referrals revenue/capital -> promotions/referral budget
//   channel_transfer  float moved between two channels     channel cash  -> channel cash

export const TREASURY_KINDS = ['capital_in', 'owner_withdrawal', 'fund_budget', 'channel_transfer'] as const;
export type TreasuryKind = (typeof TREASURY_KINDS)[number];
const SOURCES = ['platform_revenue', 'fees', 'owner_capital'] as const;
const BUDGETS = ['promotions_budget', 'referral_budget'] as const;

export interface TreasuryInput {
  kind: TreasuryKind;
  currency: string;
  amountMinor: bigint;
  channel?: string | undefined;
  toChannel?: string | undefined;
  source?: string | undefined;
  budget?: string | undefined;
  externalRef?: string | undefined;
  note: string;
}

export async function requestTreasury(db: PoolClient, staffId: number, input: TreasuryInput): Promise<string> {
  const channelAccount = async (code: string | undefined, field: string) => {
    if (!code) throw badRequest('validation_failed', 'Choose a channel.', { [field]: ['Choose a channel.'] });
    const channel = await channelByCode(db, code);
    if (channel.currency !== input.currency) throw badRequest('validation_failed', 'That channel uses another currency.', { [field]: ['Wrong currency.'] });
    return accountId(db, { kind: 'payment_clearing', channelId: channel.id, currency: input.currency });
  };
  const pick = <T extends string>(value: string | undefined, allowed: readonly T[], field: string): T => {
    if (!value || !(allowed as readonly string[]).includes(value)) throw badRequest('validation_failed', 'Choose an account.', { [field]: ['Choose an account.'] });
    return value as T;
  };
  let from: number;
  let to: number;
  switch (input.kind) {
    case 'capital_in':
      from = await channelAccount(input.channel, 'channel');
      to = await accountId(db, { kind: 'owner_capital', currency: input.currency });
      break;
    case 'owner_withdrawal':
      from = await accountId(db, { kind: pick(input.source, SOURCES, 'source'), currency: input.currency });
      to = await channelAccount(input.channel, 'channel');
      break;
    case 'fund_budget':
      from = await accountId(db, { kind: pick(input.source, SOURCES, 'source'), currency: input.currency });
      to = await accountId(db, { kind: pick(input.budget, BUDGETS, 'budget'), currency: input.currency });
      break;
    case 'channel_transfer':
      from = await channelAccount(input.toChannel, 'toChannel');
      to = await channelAccount(input.channel, 'channel');
      break;
  }
  if (from === to) throw badRequest('validation_failed', 'Choose two different accounts.');
  const ref = input.externalRef ? normalizeTxnId(input.externalRef) : null;
  const row = await one<{ public_id: string }>(
    db,
    `INSERT INTO treasury_requests (kind, currency_code, amount_minor, from_account_id, to_account_id, external_ref, note, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING public_id`,
    [input.kind, input.currency, input.amountMinor.toString(), from, to, ref, input.note, staffId],
  );
  return row.public_id;
}

export async function decideTreasury(db: PoolClient, staffId: number, publicId: string, approve: boolean, note: string | null) {
  const r = await maybeOne<{ id: string; kind: string; status: string; requested_by: string; from_account_id: string; to_account_id: string; amount_minor: string; note: string }>(
    db, 'SELECT id, kind, status, requested_by, from_account_id, to_account_id, amount_minor, note FROM treasury_requests WHERE public_id = $1 FOR UPDATE', [publicId],
  );
  if (!r) throw notFound();
  if (r.status !== 'pending') throw conflict('treasury.decided', 'This request was already decided.');
  if (Number(r.requested_by) === staffId) throw forbidden('treasury.same_person', 'A different admin must approve a request you made.');
  let txn: number | null = null;
  if (approve) {
    try {
      txn = await post(db, {
        kind: `treasury_${r.kind}`, memo: r.note, refType: 'treasury', refId: publicId, actorUserId: staffId,
        legs: move(Number(r.from_account_id), Number(r.to_account_id), BigInt(r.amount_minor)),
      });
    } catch (err) {
      if (err instanceof InsufficientFundsError) throw conflict('treasury.insufficient', 'The source account does not hold enough for this.');
      throw err;
    }
  }
  await db.query(
    'UPDATE treasury_requests SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4, ledger_transaction_id = $5 WHERE id = $1',
    [r.id, approve ? 'approved' : 'rejected', staffId, note, txn],
  );
  return { kind: r.kind, amountMinor: r.amount_minor, status: approve ? 'approved' : 'rejected' };
}

export async function listTreasury(db: Db) {
  const list = await rows<{
    public_id: string; kind: string; currency_code: string; amount_minor: string; external_ref: string | null; note: string; status: string;
    created_at: Date; decided_at: Date | null; decision_note: string | null; requested_by: string; decided_by: string | null;
    from_kind: string; from_channel: string | null; to_kind: string; to_channel: string | null;
  }>(
    db,
    `SELECT r.public_id, r.kind, r.currency_code, r.amount_minor, r.external_ref, r.note, r.status, r.created_at, r.decided_at, r.decision_note,
            ru.username AS requested_by, du.username AS decided_by, fa.kind AS from_kind, fc.name AS from_channel, ta.kind AS to_kind, tc.name AS to_channel
     FROM treasury_requests r
     JOIN users ru ON ru.id = r.requested_by LEFT JOIN users du ON du.id = r.decided_by
     JOIN accounts fa ON fa.id = r.from_account_id LEFT JOIN payment_channels fc ON fc.id = fa.channel_id
     JOIN accounts ta ON ta.id = r.to_account_id LEFT JOIN payment_channels tc ON tc.id = ta.channel_id
     ORDER BY (r.status = 'pending') DESC, r.id DESC LIMIT 50`,
  );
  return list.map(r => ({
    id: r.public_id, kind: r.kind, currency: r.currency_code, amountMinor: r.amount_minor, externalRef: r.external_ref, note: r.note, status: r.status,
    createdAt: r.created_at, decidedAt: r.decided_at, decisionNote: r.decision_note, requestedBy: r.requested_by, decidedBy: r.decided_by,
    ...direction(r),
  }));
}

// from_account_id is the debited account and to_account_id the credited one. Cash on a channel is debit-normal,
// so the direction money travels is described per kind.
function direction(r: { kind: string; from_kind: string; from_channel: string | null; to_kind: string; to_channel: string | null }) {
  switch (r.kind) {
    case 'capital_in': return { from: 'owner', to: r.from_channel ?? '' };
    case 'owner_withdrawal': return { from: r.from_kind, to: `owner via ${r.to_channel ?? ''}` };
    case 'channel_transfer': return { from: r.to_channel ?? '', to: r.from_channel ?? '' };
    default: return { from: r.from_kind, to: r.to_kind };
  }
}
