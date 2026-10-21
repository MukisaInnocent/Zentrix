import { randomBytes } from 'node:crypto';
import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';
import { badRequest } from '../../lib/errors.js';
import { distributeReferralRewards } from '../referrals/service.js';

export interface WalletSummary {
  currency: string;
  availableBalanceMinor: string;
  reservedBalanceMinor: string;
  totalDepositedMinor: string;
  totalWithdrawnMinor: string;
  totalReferralEarnedMinor: string;
  taskBalancesMinor: {
    youtube: string;
    tiktok: string;
    ads: string;
    trivia: string;
    fixtap: string;
    music: string;
  };
  membershipActive: boolean;
  membershipActivatedAt: Date | null;
}

export interface TransactionRecord {
  id: string;
  kind: string;
  amountMinor: string;
  currency: string;
  balanceAfterMinor: string;
  description: string;
  reference: string | null;
  createdAt: Date;
}

export async function getOrCreateWallet(db: Db, userId: number): Promise<void> {
  const user = await one<{ currency_code: string }>(db, 'SELECT currency_code FROM users WHERE id = $1', [userId]);
  await db.query(
    'INSERT INTO wallets (user_id, currency_code) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING',
    [userId, user.currency_code],
  );
}

export async function getWalletSummary(db: Db, userId: number): Promise<WalletSummary> {
  await getOrCreateWallet(db, userId);

  const row = await one<{
    currency_code: string;
    balance_minor: string;
    task_balance_youtube_minor: string;
    task_balance_tiktok_minor: string;
    task_balance_ads_minor: string;
    task_balance_trivia_minor: string;
    task_balance_fixtap_minor: string;
    task_balance_music_minor: string;
    total_deposited_minor: string;
    total_withdrawn_minor: string;
    reserved_balance_minor: string;
    total_referral_earned_minor: string;
    membership_active: boolean;
    membership_activated_at: Date | null;
  }>(
    db,
    `SELECT currency_code, balance_minor, task_balance_youtube_minor, task_balance_tiktok_minor,
            task_balance_ads_minor, task_balance_trivia_minor, task_balance_fixtap_minor, task_balance_music_minor,
            total_deposited_minor, total_withdrawn_minor, reserved_balance_minor, total_referral_earned_minor,
            membership_active, membership_activated_at
     FROM wallets WHERE user_id = $1`,
    [userId],
  );

  return {
    currency: row.currency_code,
    availableBalanceMinor: row.balance_minor,
    reservedBalanceMinor: row.reserved_balance_minor,
    totalDepositedMinor: row.total_deposited_minor,
    totalWithdrawnMinor: row.total_withdrawn_minor,
    totalReferralEarnedMinor: row.total_referral_earned_minor,
    taskBalancesMinor: {
      youtube: row.task_balance_youtube_minor,
      tiktok: row.task_balance_tiktok_minor,
      ads: row.task_balance_ads_minor,
      trivia: row.task_balance_trivia_minor,
      fixtap: row.task_balance_fixtap_minor,
      music: row.task_balance_music_minor,
    },
    membershipActive: row.membership_active,
    membershipActivatedAt: row.membership_activated_at,
  };
}

export async function getTransactions(db: Db, userId: number, limit = 50): Promise<TransactionRecord[]> {
  const result = await rows<{
    id: string;
    kind: string;
    amount_minor: string;
    currency_code: string;
    balance_after_minor: string;
    description: string;
    reference: string | null;
    created_at: Date;
  }>(
    db,
    `SELECT id, kind, amount_minor, currency_code, balance_after_minor, description, reference, created_at
     FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );

  return result.map(t => ({
    id: t.id,
    kind: t.kind,
    amountMinor: t.amount_minor,
    currency: t.currency_code,
    balanceAfterMinor: t.balance_after_minor,
    description: t.description,
    reference: t.reference,
    createdAt: t.created_at,
  }));
}

export async function recordDeposit(
  db: Db,
  userId: number,
  amountMinor: bigint,
  method: string,
  destination?: string,
): Promise<{ reference: string; newBalanceMinor: string }> {
  if (amountMinor <= 0n) throw badRequest('validation_failed', 'Amount must be greater than zero.');
  await getOrCreateWallet(db, userId);

  const reference = `DP-${randomBytes(4).toString('hex').toUpperCase()}`;
  const user = await one<{ currency_code: string }>(db, 'SELECT currency_code FROM users WHERE id = $1', [userId]);

  await db.query(
    `INSERT INTO money_requests (user_id, kind, amount_minor, fee_minor, currency_code, method, destination, reference, status, completed_at)
     VALUES ($1, 'deposit', $2, 0, $3, $4, $5, $6, 'completed', now())`,
    [userId, amountMinor.toString(), user.currency_code, method, destination ?? null, reference],
  );

  const updated = await one<{ balance_minor: string }>(
    db,
    `UPDATE wallets
     SET balance_minor = balance_minor + $1,
         total_deposited_minor = total_deposited_minor + $1,
         updated_at = now()
     WHERE user_id = $2
     RETURNING balance_minor`,
    [amountMinor.toString(), userId],
  );

  await db.query(
    `INSERT INTO wallet_transactions (user_id, kind, amount_minor, currency_code, balance_after_minor, description, reference)
     VALUES ($1, 'deposit', $2, $3, $4, $5, $6)`,
    [userId, amountMinor.toString(), user.currency_code, updated.balance_minor, `Deposit via ${method}`, reference],
  );

  return { reference, newBalanceMinor: updated.balance_minor };
}

export async function requestWithdrawal(
  db: Db,
  userId: number,
  amountMinor: bigint,
  method: string,
  destination: string,
): Promise<{ reference: string; feeMinor: string; newBalanceMinor: string }> {
  if (amountMinor < 1000n) throw badRequest('validation_failed', 'Minimum withdrawal is UGX 1,000.');
  await getOrCreateWallet(db, userId);

  // 0.5% withdrawal fee (50 basis points)
  const feeMinor = (amountMinor * 50n + 5000n) / 10000n;
  const totalDeduction = amountMinor + feeMinor;

  const currentWallet = await one<{ balance_minor: string; currency_code: string }>(
    db,
    'SELECT balance_minor, currency_code FROM wallets WHERE user_id = $1 FOR UPDATE',
    [userId],
  );

  if (BigInt(currentWallet.balance_minor) < totalDeduction) {
    throw badRequest('insufficient_funds', 'Insufficient funds for this withdrawal and the 0.5% processing fee.');
  }

  const reference = `WD-${randomBytes(4).toString('hex').toUpperCase()}`;

  await db.query(
    `INSERT INTO money_requests (user_id, kind, amount_minor, fee_minor, currency_code, method, destination, reference, status, completed_at)
     VALUES ($1, 'withdrawal', $2, $3, $4, $5, $6, $7, 'completed', now())`,
    [userId, amountMinor.toString(), feeMinor.toString(), currentWallet.currency_code, method, destination, reference],
  );

  const updated = await one<{ balance_minor: string }>(
    db,
    `UPDATE wallets
     SET balance_minor = balance_minor - $1,
         total_withdrawn_minor = total_withdrawn_minor + $2,
         updated_at = now()
     WHERE user_id = $3
     RETURNING balance_minor`,
    [totalDeduction.toString(), amountMinor.toString(), userId],
  );

  await db.query(
    `INSERT INTO wallet_transactions (user_id, kind, amount_minor, currency_code, balance_after_minor, description, reference)
     VALUES ($1, 'withdrawal', $2, $3, $4, $5, $6)`,
    [
      userId,
      (-totalDeduction).toString(),
      currentWallet.currency_code,
      updated.balance_minor,
      `Withdrawal to ${destination} (fee UGX ${feeMinor.toString()})`,
      reference,
    ],
  );

  return { reference, feeMinor: feeMinor.toString(), newBalanceMinor: updated.balance_minor };
}

export async function activateMembership(
  db: Db,
  userId: number,
): Promise<{ alreadyActive: boolean; referralsRewarded: number; activatedAt: Date }> {
  await getOrCreateWallet(db, userId);

  const wallet = await one<{ membership_active: boolean; membership_activated_at: Date | null }>(
    db,
    'SELECT membership_active, membership_activated_at FROM wallets WHERE user_id = $1 FOR UPDATE',
    [userId],
  );

  if (wallet.membership_active) {
    return {
      alreadyActive: true,
      referralsRewarded: 0,
      activatedAt: wallet.membership_activated_at ?? new Date(),
    };
  }

  const activatedAt = new Date();
  await db.query(
    `UPDATE wallets
     SET membership_active = true,
         membership_activated_at = $1,
         updated_at = now()
     WHERE user_id = $2`,
    [activatedAt, userId],
  );

  // Distribute multi-level referral rewards up the chain!
  // Level 1: UGX 10,000, Level 2: UGX 5,000, Level 3: UGX 2,000, etc.
  const { distributedCount } = await distributeReferralRewards(db, userId);

  return {
    alreadyActive: false,
    referralsRewarded: distributedCount,
    activatedAt,
  };
}
