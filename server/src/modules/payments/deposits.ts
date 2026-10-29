import type { PoolClient } from '../../db/pool.js';
import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';
import { badRequest, conflict, DB_ERRORS, forbidden, notFound, pgErrorCode } from '../../lib/errors.js';
import { toDecimalString } from '../../lib/money.js';
import { accountId, move, post } from '../ledger/ledger.js';
import { distributeReferralRewards } from '../referrals/service.js';
import { memberInfo, newReference, requireActive, requireConfig } from '../wallet/service.js';
import { assertNotPaused, channelByCode, exponentOf, normalizePhone, normalizeTxnId, setActor, settleProviderRequest } from './common.js';

// Manual deposits (owner decisions of 2026-10-24 and 2026-10-25). A member sends money to a business channel,
// then claims it with the mobile-money transaction ID. Staff find the payment on the channel statement and
// confirm it; only then does the ledger move. Two kinds:
//   activation  exactly the activation fee: cash on the channel -> platform revenue, the account is activated
//               with a numbered receipt, and referral rewards are paid;
//   wallet      any amount, after activation: cash on the channel -> the member's deposit balance (kept apart
//               from the balance, which holds referral money only).

export type DepositPurpose = 'activation' | 'wallet';
const MAX_PENDING: Record<DepositPurpose, number> = { activation: 1, wallet: 3 };

export interface DepositClaim {
  purpose?: DepositPurpose;
  // 'api': the member pays through the provider (LivePay); the claim carries our own reference as its transaction ID.
  method?: 'manual' | 'api';
  // Wallet deposits only: the amount the member says they sent. An activation is always the fee.
  amountMinor?: bigint;
  channelCode: string;
  senderPhone: string;
  providerTxnId?: string;
  note?: string | undefined;
}

export interface DepositView {
  id: string;
  reference: string;
  channel: { code: string; name: string };
  purpose: DepositPurpose;
  method: 'manual' | 'api';
  claimedAmountMinor: string;
  creditedAmountMinor: string | null;
  currency: string;
  senderPhone: string;
  providerTxnId: string;
  memberNote: string | null;
  status: string;
  reviewNote: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

export const DEPOSIT_SELECT = `
  SELECT d.id, d.public_id, d.reference, d.user_id, d.claimed_amount_minor, d.credited_amount_minor, d.currency_code, d.sender_phone,
         d.provider_txn_id, d.member_note, d.status, d.review_note, d.reviewed_at, d.reviewed_by, d.created_at, d.channel_id,
         d.purpose, d.method, c.code AS channel_code, c.name AS channel_name
  FROM deposits d JOIN payment_channels c ON c.id = d.channel_id`;

export interface DepositRow {
  id: string; public_id: string; reference: string; user_id: string; claimed_amount_minor: string; credited_amount_minor: string | null;
  currency_code: string; sender_phone: string; provider_txn_id: string; member_note: string | null; status: string; review_note: string | null;
  reviewed_at: Date | null; reviewed_by: string | null; created_at: Date; channel_id: string; channel_code: string; channel_name: string;
  purpose: DepositPurpose; method: 'manual' | 'api';
}

export const depositView = (d: DepositRow): DepositView => ({
  id: d.public_id, reference: d.reference, channel: { code: d.channel_code, name: d.channel_name }, purpose: d.purpose, method: d.method,
  claimedAmountMinor: d.claimed_amount_minor, creditedAmountMinor: d.credited_amount_minor, currency: d.currency_code,
  senderPhone: d.sender_phone, providerTxnId: d.provider_txn_id, memberNote: d.member_note, status: d.status,
  reviewNote: d.review_note, reviewedAt: d.reviewed_at, createdAt: d.created_at,
});

export async function submitDeposit(db: PoolClient, userId: number, claim: DepositClaim): Promise<DepositView> {
  await db.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
  const member = await memberInfo(db, userId);
  requireActive(member);
  const purpose = claim.purpose ?? 'activation';
  const activated = Boolean(await maybeOne(db, 'SELECT 1 FROM memberships WHERE user_id = $1', [userId]));
  if (purpose === 'activation' && activated) throw badRequest('deposit.already_active', 'Your account is already activated.');
  if (purpose === 'wallet' && !activated) throw forbidden('activation.required', 'Pay the activation fee before making a deposit.');
  const channel = await channelByCode(db, claim.channelCode);
  if (!channel.depositsEnabled || channel.currency !== member.currency || channel.countryCode !== member.countryCode) {
    throw badRequest('payments.channel_unavailable', 'That payment method is not available for your country.');
  }
  const method = claim.method ?? 'manual';
  if ((method === 'api') !== Boolean(channel.provider)) {
    throw badRequest('payments.channel_method', channel.provider ? 'Pay with this method from the payment prompt on your phone.' : 'This payment method takes manual payments only.');
  }
  await assertNotPaused(db, 'deposits_paused', member.currency);
  const amount = purpose === 'activation' ? BigInt((await requireConfig(db, member.countryCode)).membershipFeeMinor) : claim.amountMinor ?? 0n;
  if (amount <= 0n) throw badRequest('validation_failed', 'Enter the amount you sent.', { amount: ['Enter the amount you sent.'] });
  const senderPhone = normalizePhone(claim.senderPhone);
  const reference = newReference('DP');
  const txnId = method === 'api' ? reference : normalizeTxnId(claim.providerTxnId ?? '');
  if (!/^[A-Z0-9.-]{4,40}$/.test(txnId)) {
    throw badRequest('validation_failed', 'Enter the transaction ID from your payment message.', { providerTxnId: ['Enter the transaction ID from your payment message.'] });
  }
  const pending = await one<{ n: string }>(db, `SELECT count(*) AS n FROM deposits WHERE user_id = $1 AND status = 'pending' AND purpose = $2`, [userId, purpose]);
  if (Number(pending.n) >= MAX_PENDING[purpose]) {
    throw badRequest('deposit.too_many_pending', 'Your payment is already waiting for review. Please wait for our team to check it.');
  }
  await setActor(db, userId, 'Payment submitted by member');
  let id: string;
  try {
    id = (await one<{ id: string }>(
      db,
      `INSERT INTO deposits (reference, user_id, channel_id, claimed_amount_minor, currency_code, sender_phone, provider_txn_id, member_note, purpose, method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [reference, userId, channel.id, amount.toString(), member.currency, senderPhone, txnId, claim.note ?? null, purpose, method],
    )).id;
  } catch (err) {
    if (pgErrorCode(err) === DB_ERRORS.uniqueViolation) {
      throw conflict('deposit.duplicate_txn', 'This transaction ID has already been submitted. If you think this is a mistake, contact support.');
    }
    throw err;
  }
  return depositView(await one<DepositRow>(db, `${DEPOSIT_SELECT} WHERE d.id = $1`, [id]));
}

export async function listMemberDeposits(db: Db, userId: number, limit = 50): Promise<DepositView[]> {
  return (await rows<DepositRow>(db, `${DEPOSIT_SELECT} WHERE d.user_id = $1 ORDER BY d.id DESC LIMIT $2`, [userId, limit])).map(depositView);
}

async function lockDeposit(db: PoolClient, publicId: string): Promise<DepositRow> {
  const row = await maybeOne<DepositRow>(db, `${DEPOSIT_SELECT} WHERE d.public_id = $1 FOR UPDATE OF d`, [publicId]);
  if (!row) throw notFound();
  return row;
}

export async function cancelDeposit(db: PoolClient, userId: number, publicId: string): Promise<DepositView> {
  const d = await lockDeposit(db, publicId);
  if (Number(d.user_id) !== userId) throw notFound();
  if (d.status !== 'pending') throw badRequest('deposit.not_pending', 'Only a deposit that is still waiting for review can be cancelled.');
  if (d.method === 'api') throw badRequest('deposit.in_flight', 'This payment is on its way through mobile money and cannot be cancelled. If you do not approve it on your phone, it fails by itself.');
  await setActor(db, userId, 'Cancelled by member');
  await db.query(`UPDATE deposits SET status = 'cancelled' WHERE id = $1`, [d.id]);
  return depositView({ ...d, status: 'cancelled' });
}

// Staff confirm the payment. A wallet deposit credits the amount actually received (a note explains any
// difference). An activation must be exactly the fee that was claimed: it cannot be part-paid, so a short or long
// payment is rejected with a reason and paid again.
export async function confirmDeposit(db: PoolClient, staffId: number, publicId: string, receivedMinor: bigint, note: string | null): Promise<{ before: DepositView; after: DepositView; receiptNo: string | null }> {
  const d = await lockDeposit(db, publicId);
  if (Number(d.user_id) === staffId) throw forbidden('admin.self_action', 'Another staff member must review your own payment.');
  if (d.status !== 'pending') throw conflict('deposit.not_pending', `This payment is already ${d.status}.`);
  await settleProviderRequest(db, { depositId: d.id }, 'succeeded', note ?? 'confirmed');
  if (d.purpose === 'wallet') return confirmWalletDeposit(db, staffId, d, receivedMinor, note);
  const fee = BigInt(d.claimed_amount_minor);
  if (receivedMinor !== fee) {
    const exponent = await exponentOf(db, d.currency_code);
    throw badRequest(
      'deposit.wrong_amount',
      `The activation fee is ${d.currency_code} ${toDecimalString(fee, exponent)}. If the statement shows a different amount, reject this payment with a reason and ask the member to pay the exact fee.`,
      { amount: ['Must equal the activation fee.'] },
    );
  }
  const userId = Number(d.user_id);
  await db.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
  const member = await memberInfo(db, userId);
  if (member.status !== 'active') throw conflict('deposit.member_not_active', 'This member account is frozen or closed. Resolve that first.');
  if (await maybeOne(db, 'SELECT 1 FROM memberships WHERE user_id = $1', [userId])) {
    throw conflict('deposit.already_active', 'This member is already activated. Reject this payment and refund it by hand if it was a double payment.');
  }
  const clearing = await accountId(db, { kind: 'payment_clearing', channelId: Number(d.channel_id), currency: d.currency_code });
  const revenue = await accountId(db, { kind: 'platform_revenue', currency: d.currency_code });
  const receiptNo = newReference('MB');
  const txn = await post(db, {
    kind: 'activation_fee', memo: `Activation fee via ${d.channel_name}`, refType: 'membership', refId: receiptNo, actorUserId: staffId,
    legs: move(clearing, revenue, fee),
  });
  await db.query(
    'INSERT INTO memberships (user_id, receipt_no, fee_minor, currency_code, ledger_transaction_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, receiptNo, fee.toString(), d.currency_code, txn],
  );
  await setActor(db, staffId, note ?? 'Confirmed against the channel statement. Account activated.');
  await db.query(
    `UPDATE deposits SET status = 'confirmed', credited_amount_minor = $2, ledger_transaction_id = $3, reviewed_by = $4, reviewed_at = now(), review_note = $5
     WHERE id = $1`,
    [d.id, fee.toString(), txn, staffId, note],
  );
  // Referral rewards for the people who invited this member (levels 1 to 3) are paid now, from platform revenue.
  await distributeReferralRewards(db, userId);
  const after = await one<DepositRow>(db, `${DEPOSIT_SELECT} WHERE d.id = $1`, [d.id]);
  return { before: depositView(d), after: depositView(after), receiptNo };
}

async function confirmWalletDeposit(db: PoolClient, staffId: number, d: DepositRow, receivedMinor: bigint, note: string | null) {
  if (receivedMinor <= 0n) throw badRequest('validation_failed', 'Enter the amount received.', { amount: ['Enter the amount received.'] });
  if (receivedMinor !== BigInt(d.claimed_amount_minor) && !note) {
    throw badRequest('validation_failed', 'Explain why the amount received differs from the claim.', { note: ['Explain why the amount differs.'] });
  }
  const member = await memberInfo(db, Number(d.user_id));
  if (member.status !== 'active') throw conflict('deposit.member_not_active', 'This member account is frozen or closed. Resolve that first.');
  const clearing = await accountId(db, { kind: 'payment_clearing', channelId: Number(d.channel_id), currency: d.currency_code });
  const deposit = await accountId(db, { kind: 'member_deposit', userId: Number(d.user_id), currency: d.currency_code });
  const txn = await post(db, {
    kind: 'deposit', memo: `Deposit via ${d.channel_name}`, refType: 'deposit', refId: d.reference, actorUserId: staffId,
    legs: move(clearing, deposit, receivedMinor),
  });
  await setActor(db, staffId, note ?? 'Confirmed against the channel statement');
  await db.query(
    `UPDATE deposits SET status = 'confirmed', credited_amount_minor = $2, ledger_transaction_id = $3, reviewed_by = $4, reviewed_at = now(), review_note = $5
     WHERE id = $1`,
    [d.id, receivedMinor.toString(), txn, staffId, note],
  );
  const after = await one<DepositRow>(db, `${DEPOSIT_SELECT} WHERE d.id = $1`, [d.id]);
  return { before: depositView(d), after: depositView(after), receiptNo: null };
}

export async function rejectDeposit(db: PoolClient, staffId: number, publicId: string, reason: string): Promise<{ before: DepositView; after: DepositView }> {
  const d = await lockDeposit(db, publicId);
  if (Number(d.user_id) === staffId) throw forbidden('admin.self_action', 'Another staff member must review your own payment.');
  if (d.status !== 'pending') throw conflict('deposit.not_pending', `This deposit is already ${d.status}.`);
  await settleProviderRequest(db, { depositId: d.id }, 'failed', reason);
  await setActor(db, staffId, reason);
  await db.query(`UPDATE deposits SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), review_note = $3 WHERE id = $1`, [d.id, staffId, reason]);
  const after = await one<DepositRow>(db, `${DEPOSIT_SELECT} WHERE d.id = $1`, [d.id]);
  return { before: depositView(d), after: depositView(after) };
}
