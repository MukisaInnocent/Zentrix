import type { PoolClient } from '../../db/pool.js';
import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';
import { badRequest, conflict, DB_ERRORS, forbidden, notFound, pgErrorCode } from '../../lib/errors.js';
import { toDecimalString } from '../../lib/money.js';
import { accountId, move, post } from '../ledger/ledger.js';
import { distributeReferralRewards } from '../referrals/service.js';
import { memberInfo, newReference, requireActive, requireConfig } from '../wallet/service.js';
import { assertNotPaused, channelByCode, exponentOf, normalizePhone, normalizeTxnId, setActor } from './common.js';

// Manual activation payment (owner decisions of 2026-10-24 and 2026-10-25). A new member sends exactly the
// activation fee to a business channel, then claims it with the mobile-money transaction ID. Staff find the
// payment on the channel statement and confirm it; only then does the ledger move (cash on the channel ->
// platform revenue), the account is activated with a numbered receipt, and referral rewards are paid.

const MAX_PENDING_PER_MEMBER = 1;

export interface DepositClaim {
  channelCode: string;
  senderPhone: string;
  providerTxnId: string;
  note?: string | undefined;
}

export interface DepositView {
  id: string;
  reference: string;
  channel: { code: string; name: string };
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
         c.code AS channel_code, c.name AS channel_name
  FROM deposits d JOIN payment_channels c ON c.id = d.channel_id`;

export interface DepositRow {
  id: string; public_id: string; reference: string; user_id: string; claimed_amount_minor: string; credited_amount_minor: string | null;
  currency_code: string; sender_phone: string; provider_txn_id: string; member_note: string | null; status: string; review_note: string | null;
  reviewed_at: Date | null; reviewed_by: string | null; created_at: Date; channel_id: string; channel_code: string; channel_name: string;
}

export const depositView = (d: DepositRow): DepositView => ({
  id: d.public_id, reference: d.reference, channel: { code: d.channel_code, name: d.channel_name },
  claimedAmountMinor: d.claimed_amount_minor, creditedAmountMinor: d.credited_amount_minor, currency: d.currency_code,
  senderPhone: d.sender_phone, providerTxnId: d.provider_txn_id, memberNote: d.member_note, status: d.status,
  reviewNote: d.review_note, reviewedAt: d.reviewed_at, createdAt: d.created_at,
});

export async function submitDeposit(db: PoolClient, userId: number, claim: DepositClaim): Promise<DepositView> {
  await db.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
  const member = await memberInfo(db, userId);
  requireActive(member);
  if (await maybeOne(db, 'SELECT 1 FROM memberships WHERE user_id = $1', [userId])) {
    throw badRequest('deposit.already_active', 'Your account is already activated.');
  }
  const channel = await channelByCode(db, claim.channelCode);
  if (!channel.depositsEnabled || channel.currency !== member.currency || channel.countryCode !== member.countryCode) {
    throw badRequest('payments.channel_unavailable', 'That payment method is not available for your country.');
  }
  await assertNotPaused(db, 'deposits_paused', member.currency);
  const fee = BigInt((await requireConfig(db, member.countryCode)).membershipFeeMinor);
  const senderPhone = normalizePhone(claim.senderPhone);
  const txnId = normalizeTxnId(claim.providerTxnId);
  if (!/^[A-Z0-9.-]{4,40}$/.test(txnId)) {
    throw badRequest('validation_failed', 'Enter the transaction ID from your payment message.', { providerTxnId: ['Enter the transaction ID from your payment message.'] });
  }
  const pending = await one<{ n: string }>(db, `SELECT count(*) AS n FROM deposits WHERE user_id = $1 AND status = 'pending'`, [userId]);
  if (Number(pending.n) >= MAX_PENDING_PER_MEMBER) {
    throw badRequest('deposit.too_many_pending', 'Your payment is already waiting for review. Please wait for our team to check it.');
  }
  await setActor(db, userId, 'Payment submitted by member');
  let id: string;
  try {
    id = (await one<{ id: string }>(
      db,
      `INSERT INTO deposits (reference, user_id, channel_id, claimed_amount_minor, currency_code, sender_phone, provider_txn_id, member_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [newReference('DP'), userId, channel.id, fee.toString(), member.currency, senderPhone, txnId, claim.note ?? null],
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
  await setActor(db, userId, 'Cancelled by member');
  await db.query(`UPDATE deposits SET status = 'cancelled' WHERE id = $1`, [d.id]);
  return depositView({ ...d, status: 'cancelled' });
}

// Staff confirm the payment. The amount received must be exactly the activation fee that was claimed: an
// activation cannot be part-paid, so a short or long payment is rejected with a reason and paid again.
export async function confirmDeposit(db: PoolClient, staffId: number, publicId: string, receivedMinor: bigint, note: string | null): Promise<{ before: DepositView; after: DepositView; receiptNo: string }> {
  const d = await lockDeposit(db, publicId);
  if (Number(d.user_id) === staffId) throw forbidden('admin.self_action', 'Another staff member must review your own payment.');
  if (d.status !== 'pending') throw conflict('deposit.not_pending', `This payment is already ${d.status}.`);
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

export async function rejectDeposit(db: PoolClient, staffId: number, publicId: string, reason: string): Promise<{ before: DepositView; after: DepositView }> {
  const d = await lockDeposit(db, publicId);
  if (Number(d.user_id) === staffId) throw forbidden('admin.self_action', 'Another staff member must review your own payment.');
  if (d.status !== 'pending') throw conflict('deposit.not_pending', `This deposit is already ${d.status}.`);
  await setActor(db, staffId, reason);
  await db.query(`UPDATE deposits SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), review_note = $3 WHERE id = $1`, [d.id, staffId, reason]);
  const after = await one<DepositRow>(db, `${DEPOSIT_SELECT} WHERE d.id = $1`, [d.id]);
  return { before: depositView(d), after: depositView(after) };
}
