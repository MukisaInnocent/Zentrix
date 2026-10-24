import type { PoolClient } from '../../db/pool.js';
import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { basisPointsOf } from '../../lib/money.js';
import type { Role } from '../auth/context.js';
import { accountId, InsufficientFundsError, post, type Leg } from '../ledger/ledger.js';
import { memberInfo, newReference, requireActive, requireConfig, sourceAccount, type BalanceSource } from '../wallet/service.js';
import { assertNotPaused, channelByCode, normalizeTxnId, setActor } from './common.js';

// Manual payouts. On request the amount plus fee moves from the chosen balance to the member's withdrawal
// hold. Staff approve, start the payout (claiming it so nobody pays twice), send the money from the business
// channel to the member's verified phone, and record the payout transaction ID. Failed or cancelled requests
// return the full hold to the balance it came from. From the approval threshold, and for new accounts, an
// admin approves and a different staff member records the payout (maker-checker).

export interface Quote {
  amountMinor: string;
  feeMinor: string;
  totalMinor: string;
  currency: string;
  needsAdminApproval: boolean;
  limits: { minMinor: string; maxMinor: string; dailyMaxMinor: string; monthlyMaxMinor: string; usedTodayMinor: string; usedThisMonthMinor: string };
}

async function windowTotals(db: Db, userId: number): Promise<{ day: bigint; month: bigint }> {
  const row = await one<{ day: string; month: string }>(
    db,
    `SELECT coalesce(sum(amount_minor) FILTER (WHERE created_at > now() - interval '1 day'), 0)::text AS day,
            coalesce(sum(amount_minor), 0)::text AS month
     FROM withdrawals WHERE user_id = $1 AND status NOT IN ('failed', 'cancelled') AND created_at > now() - interval '30 days'`,
    [userId],
  );
  return { day: BigInt(row.day), month: BigInt(row.month) };
}

export async function quoteWithdrawal(db: Db, userId: number, amountMinor: bigint): Promise<Quote> {
  const member = await memberInfo(db, userId);
  const config = await requireConfig(db, member.countryCode);
  const fee = [basisPointsOf(amountMinor, config.withdrawalFeeBp), BigInt(config.withdrawalFeeMinMinor)].reduce((a, b) => (a > b ? a : b));
  const used = await windowTotals(db, userId);
  const ageDays = (Date.now() - member.createdAt.getTime()) / 86_400_000;
  return {
    amountMinor: amountMinor.toString(),
    feeMinor: fee.toString(),
    totalMinor: (amountMinor + fee).toString(),
    currency: member.currency,
    needsAdminApproval: amountMinor >= BigInt(config.withdrawalApprovalThresholdMinor) || ageDays < config.newAccountReviewDays,
    limits: {
      minMinor: config.withdrawalMinMinor, maxMinor: config.withdrawalMaxMinor, dailyMaxMinor: config.withdrawalDailyMaxMinor,
      monthlyMaxMinor: config.withdrawalMonthlyMaxMinor, usedTodayMinor: used.day.toString(), usedThisMonthMinor: used.month.toString(),
    },
  };
}

export interface WithdrawalView {
  id: string;
  reference: string;
  source: string;
  channel: { code: string; name: string };
  payoutPhone: string;
  amountMinor: string;
  feeMinor: string;
  currency: string;
  status: string;
  needsAdminApproval: boolean;
  payoutTxnId: string | null;
  closedReason: string | null;
  createdAt: Date;
  approvedAt: Date | null;
  processingAt: Date | null;
  paidAt: Date | null;
  closedAt: Date | null;
}

export const WITHDRAWAL_SELECT = `
  SELECT w.*, c.code AS channel_code, c.name AS channel_name
  FROM withdrawals w JOIN payment_channels c ON c.id = w.channel_id`;

export interface WithdrawalRow {
  id: string; public_id: string; reference: string; user_id: string; source: string; source_account_id: string; channel_id: string;
  payout_phone: string; amount_minor: string; fee_minor: string; currency_code: string; needs_two_people: boolean; status: string;
  approved_by: string | null; approved_at: Date | null; processing_by: string | null; processing_at: Date | null; paid_by: string | null;
  paid_at: Date | null; payout_txn_id: string | null; closed_by: string | null; closed_reason: string | null; closed_at: Date | null;
  created_at: Date; channel_code: string; channel_name: string;
}

export const withdrawalView = (w: WithdrawalRow): WithdrawalView => ({
  id: w.public_id, reference: w.reference, source: w.source, channel: { code: w.channel_code, name: w.channel_name }, payoutPhone: w.payout_phone,
  amountMinor: w.amount_minor, feeMinor: w.fee_minor, currency: w.currency_code, status: w.status, needsAdminApproval: w.needs_two_people,
  payoutTxnId: w.payout_txn_id, closedReason: w.closed_reason, createdAt: w.created_at, approvedAt: w.approved_at,
  processingAt: w.processing_at, paidAt: w.paid_at, closedAt: w.closed_at,
});

export async function requestWithdrawal(db: PoolClient, userId: number, input: { source: BalanceSource; amountMinor: bigint; channelCode: string }): Promise<{ withdrawal: WithdrawalView; quote: Quote }> {
  await db.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
  const member = await memberInfo(db, userId);
  requireActive(member);
  if (!member.phone || !member.phoneVerified) throw forbidden('withdrawal.phone_unverified', 'Verify your phone number before withdrawing. Payouts go only to your verified number.');
  if (member.withdrawalsLockedUntil && member.withdrawalsLockedUntil > new Date()) {
    throw forbidden('withdrawal.locked', 'Withdrawals are locked for 48 hours after a phone number change.');
  }
  await assertNotPaused(db, 'withdrawals_paused', member.currency);
  const channel = await channelByCode(db, input.channelCode);
  if (!channel.payoutsEnabled || channel.currency !== member.currency) {
    throw badRequest('payments.channel_unavailable', 'That payout method is not available for your account.');
  }
  const quote = await quoteWithdrawal(db, userId, input.amountMinor);
  const amount = input.amountMinor;
  const field = (message: string) => badRequest('validation_failed', message, { amount: [message] });
  if (amount < BigInt(quote.limits.minMinor)) throw field('This is below the minimum withdrawal.');
  if (amount > BigInt(quote.limits.maxMinor)) throw field('This is above the maximum for one withdrawal.');
  if (BigInt(quote.limits.usedTodayMinor) + amount > BigInt(quote.limits.dailyMaxMinor)) throw field('This would pass your daily withdrawal limit.');
  if (BigInt(quote.limits.usedThisMonthMinor) + amount > BigInt(quote.limits.monthlyMaxMinor)) throw field('This would pass your monthly withdrawal limit.');

  const source = await sourceAccount(db, userId, member.currency, input.source);
  const hold = await accountId(db, { kind: 'member_withdrawal_hold', userId, currency: member.currency });
  const reference = newReference('WD');
  const total = BigInt(quote.totalMinor);
  let txn: number;
  try {
    txn = await post(db, {
      kind: 'withdrawal_hold', memo: `Withdrawal ${reference} requested (fee included)`, refType: 'withdrawal', refId: reference, actorUserId: userId,
      legs: [{ account: source, side: 'debit', amountMinor: total }, { account: hold, side: 'credit', amountMinor: total }],
    });
  } catch (err) {
    if (err instanceof InsufficientFundsError) throw field('This balance is too low for the amount plus the withdrawal fee.');
    throw err;
  }
  await setActor(db, userId, 'Requested by member');
  const row = await one<{ id: string }>(
    db,
    `INSERT INTO withdrawals (reference, user_id, source, source_account_id, channel_id, payout_phone, amount_minor, fee_minor, currency_code,
       needs_two_people, hold_transaction_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [reference, userId, input.source, source, channel.id, member.phone, amount.toString(), quote.feeMinor, member.currency, quote.needsAdminApproval, txn],
  );
  return { withdrawal: withdrawalView(await one<WithdrawalRow>(db, `${WITHDRAWAL_SELECT} WHERE w.id = $1`, [row.id])), quote };
}

export async function listMemberWithdrawals(db: Db, userId: number, limit = 50): Promise<WithdrawalView[]> {
  return (await rows<WithdrawalRow>(db, `${WITHDRAWAL_SELECT} WHERE w.user_id = $1 ORDER BY w.id DESC LIMIT $2`, [userId, limit])).map(withdrawalView);
}

async function lockWithdrawal(db: PoolClient, publicId: string): Promise<WithdrawalRow> {
  const row = await maybeOne<WithdrawalRow>(db, `${WITHDRAWAL_SELECT} WHERE w.public_id = $1 FOR UPDATE OF w`, [publicId]);
  if (!row) throw notFound();
  return row;
}

const reload = async (db: Db, id: string) => withdrawalView(await one<WithdrawalRow>(db, `${WITHDRAWAL_SELECT} WHERE w.id = $1`, [id]));

// Returns the whole hold (amount + fee) to the balance it came from.
async function release(db: PoolClient, w: WithdrawalRow, actorId: number, status: 'failed' | 'cancelled', reason: string): Promise<void> {
  const hold = await accountId(db, { kind: 'member_withdrawal_hold', userId: Number(w.user_id), currency: w.currency_code });
  const total = BigInt(w.amount_minor) + BigInt(w.fee_minor);
  const txn = await post(db, {
    kind: status === 'failed' ? 'withdrawal_failed' : 'withdrawal_cancelled', memo: `Withdrawal ${w.reference} ${status}: funds returned`,
    refType: 'withdrawal', refId: w.reference, actorUserId: actorId,
    legs: [{ account: hold, side: 'debit', amountMinor: total }, { account: Number(w.source_account_id), side: 'credit', amountMinor: total }],
  });
  await setActor(db, actorId, reason);
  await db.query(
    'UPDATE withdrawals SET status = $2, final_transaction_id = $3, closed_by = $4, closed_reason = $5, closed_at = now() WHERE id = $1',
    [w.id, status, txn, actorId, reason],
  );
}

export async function memberCancelWithdrawal(db: PoolClient, userId: number, publicId: string): Promise<WithdrawalView> {
  const w = await lockWithdrawal(db, publicId);
  if (Number(w.user_id) !== userId) throw notFound();
  if (w.status !== 'requested') throw badRequest('withdrawal.not_cancellable', 'This withdrawal is already being handled and cannot be cancelled.');
  await release(db, w, userId, 'cancelled', 'Cancelled by member');
  return reload(db, w.id);
}

export type StaffAction = 'approve' | 'start' | 'paid' | 'fail' | 'cancel';

export interface StaffActionInput {
  action: StaffAction;
  staffId: number;
  roles: Role[];
  note?: string | null | undefined;
  payoutTxnId?: string | undefined;
}

export async function staffWithdrawalAction(db: PoolClient, publicId: string, input: StaffActionInput): Promise<{ before: WithdrawalView; after: WithdrawalView }> {
  const w = await lockWithdrawal(db, publicId);
  const before = withdrawalView(w);
  const { staffId } = input;
  if (Number(w.user_id) === staffId) throw forbidden('admin.self_action', 'Another staff member must handle your own withdrawal.');
  const expect = (...states: string[]) => {
    if (!states.includes(w.status)) throw conflict('withdrawal.wrong_state', `This withdrawal is ${w.status}; refresh to see its latest state.`);
  };
  if (input.action === 'approve' || input.action === 'start') {
    const member = await memberInfo(db, Number(w.user_id));
    if (member.status !== 'active') throw conflict('withdrawal.member_not_active', 'This member account is frozen or closed. Cancel the withdrawal or resolve the account first.');
  }

  switch (input.action) {
    case 'approve': {
      expect('requested');
      if (w.needs_two_people && !input.roles.includes('admin')) {
        throw forbidden('withdrawal.admin_required', 'An admin must approve this withdrawal (large amount or new account).');
      }
      await assertNotPaused(db, 'withdrawals_paused', w.currency_code);
      await setActor(db, staffId, input.note ?? 'Approved');
      await db.query(`UPDATE withdrawals SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`, [w.id, staffId]);
      break;
    }
    case 'start': {
      expect('approved');
      if (w.needs_two_people && String(staffId) === w.approved_by) {
        throw forbidden('withdrawal.two_people', 'A different staff member from the approver must send this payout.');
      }
      await assertNotPaused(db, 'withdrawals_paused', w.currency_code);
      await setActor(db, staffId, input.note ?? 'Payout started');
      await db.query(`UPDATE withdrawals SET status = 'processing', processing_by = $2, processing_at = now() WHERE id = $1`, [w.id, staffId]);
      break;
    }
    case 'paid': {
      expect('processing');
      if (w.needs_two_people && String(staffId) === w.approved_by) {
        throw forbidden('withdrawal.two_people', 'A different staff member from the approver must record this payout.');
      }
      const txnId = normalizeTxnId(input.payoutTxnId ?? '');
      if (!/^[A-Z0-9.-]{4,40}$/.test(txnId)) {
        throw badRequest('validation_failed', 'Enter the payout transaction ID.', { payoutTxnId: ['Enter the payout transaction ID.'] });
      }
      if (await maybeOne(db, 'SELECT 1 FROM withdrawals WHERE channel_id = $1 AND payout_txn_id = $2', [w.channel_id, txnId])) {
        throw conflict('withdrawal.duplicate_txn', 'That payout transaction ID is already recorded on another withdrawal.');
      }
      const hold = await accountId(db, { kind: 'member_withdrawal_hold', userId: Number(w.user_id), currency: w.currency_code });
      const clearing = await accountId(db, { kind: 'payment_clearing', channelId: Number(w.channel_id), currency: w.currency_code });
      const amount = BigInt(w.amount_minor);
      const fee = BigInt(w.fee_minor);
      const legs: Leg[] = [{ account: hold, side: 'debit', amountMinor: amount + fee }, { account: clearing, side: 'credit', amountMinor: amount }];
      if (fee > 0n) legs.push({ account: await accountId(db, { kind: 'fees', currency: w.currency_code }), side: 'credit', amountMinor: fee });
      let txn: number;
      try {
        txn = await post(db, { kind: 'withdrawal_paid', memo: `Withdrawal ${w.reference} paid via ${w.channel_name}`, refType: 'withdrawal', refId: w.reference, actorUserId: staffId, legs });
      } catch (err) {
        if (err instanceof InsufficientFundsError) {
          throw conflict('withdrawal.channel_short', `The ledger shows less money held on ${w.channel_name} than this payout. Record a channel transfer first.`);
        }
        throw err;
      }
      await setActor(db, staffId, input.note ?? `Paid, transaction ${txnId}`);
      await db.query(
        `UPDATE withdrawals SET status = 'paid', paid_by = $2, paid_at = now(), payout_txn_id = $3, final_transaction_id = $4 WHERE id = $1`,
        [w.id, staffId, txnId, txn],
      );
      break;
    }
    case 'fail': {
      expect('processing');
      if (!input.note) throw badRequest('validation_failed', 'Say why the payout failed.', { note: ['Say why the payout failed.'] });
      await release(db, w, staffId, 'failed', input.note);
      break;
    }
    case 'cancel': {
      expect('requested', 'approved');
      if (!input.note) throw badRequest('validation_failed', 'Give the member a reason.', { note: ['Give the member a reason.'] });
      await release(db, w, staffId, 'cancelled', input.note);
      break;
    }
  }
  return { before, after: await reload(db, w.id) };
}
