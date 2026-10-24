import type { PoolClient } from '../../db/pool.js';
import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';
import { randomCode } from '../../lib/crypto.js';
import { badRequest, forbidden } from '../../lib/errors.js';
import { currentCountryConfig, type CountryConfig } from '../countries/service.js';
import { accountId, InsufficientFundsError, move, post, TASK_MODULES, type TaskModule } from '../ledger/ledger.js';
import { distributeReferralRewards } from '../referrals/service.js';

export const BALANCE_SOURCES = ['main', ...TASK_MODULES] as const;
export type BalanceSource = (typeof BALANCE_SOURCES)[number];

export interface MemberInfo {
  id: number;
  username: string;
  status: string;
  countryCode: string;
  currency: string;
  phone: string | null;
  phoneVerified: boolean;
  withdrawalsLockedUntil: Date | null;
  createdAt: Date;
}

export async function memberInfo(db: Db, userId: number): Promise<MemberInfo> {
  const u = await one<{
    username: string; status: string; country_code: string; currency_code: string; phone_e164: string | null;
    phone_verified: boolean; withdrawals_locked_until: Date | null; created_at: Date;
  }>(
    db,
    `SELECT username, status, country_code, currency_code, phone_e164, phone_verified_at IS NOT NULL AS phone_verified,
            withdrawals_locked_until, created_at FROM users WHERE id = $1`,
    [userId],
  );
  return {
    id: userId, username: u.username, status: u.status, countryCode: u.country_code, currency: u.currency_code, phone: u.phone_e164,
    phoneVerified: u.phone_verified, withdrawalsLockedUntil: u.withdrawals_locked_until, createdAt: u.created_at,
  };
}

export async function requireConfig(db: Db, countryCode: string): Promise<CountryConfig> {
  const config = await currentCountryConfig(db, countryCode);
  if (!config) throw badRequest('payments.not_configured', 'Payments are not set up for your country yet.');
  return config;
}

export function requireActive(member: MemberInfo): void {
  if (member.status !== 'active') throw forbidden('account.frozen', 'Your account is on hold. Contact support.');
}

// The member's account for a balance source (main balance or one task module).
export function sourceAccount(db: Db, userId: number, currency: string, source: BalanceSource): Promise<number> {
  return source === 'main'
    ? accountId(db, { kind: 'member_main', userId, currency })
    : accountId(db, { kind: 'member_task', userId, module: source, currency });
}

export interface WalletSummary {
  currency: string;
  availableBalanceMinor: string;
  reservedBalanceMinor: string;
  pendingDepositsMinor: string;
  totalDepositedMinor: string;
  totalWithdrawnMinor: string;
  totalReferralEarnedMinor: string;
  taskBalancesMinor: Record<TaskModule, string>;
  membershipActive: boolean;
  membershipActivatedAt: Date | null;
  membershipFeeMinor: string | null;
}

export async function getWalletSummary(db: Db, userId: number): Promise<WalletSummary> {
  const member = await memberInfo(db, userId);
  const [balances, totals, membership, config] = await Promise.all([
    rows<{ kind: string; module: string | null; balance_minor: string }>(
      db, 'SELECT kind, module, balance_minor FROM accounts WHERE user_id = $1 AND currency_code = $2', [userId, member.currency],
    ),
    one<{ deposited: string; pending: string; withdrawn: string; referral: string }>(
      db,
      `SELECT (SELECT coalesce(sum(credited_amount_minor), 0) FROM deposits WHERE user_id = $1 AND status = 'confirmed')::text AS deposited,
              (SELECT coalesce(sum(claimed_amount_minor), 0) FROM deposits WHERE user_id = $1 AND status = 'pending')::text AS pending,
              (SELECT coalesce(sum(amount_minor), 0) FROM withdrawals WHERE user_id = $1 AND status = 'paid')::text AS withdrawn,
              (SELECT coalesce(sum(amount_minor), 0) FROM referral_rewards WHERE referrer_user_id = $1 AND status = 'credited')::text AS referral`,
      [userId],
    ),
    maybeOne<{ activated_at: Date }>(db, 'SELECT activated_at FROM memberships WHERE user_id = $1', [userId]),
    currentCountryConfig(db, member.countryCode),
  ]);
  const find = (kind: string, module: string | null = null) =>
    balances.find(b => b.kind === kind && b.module === module)?.balance_minor ?? '0';
  return {
    currency: member.currency,
    availableBalanceMinor: find('member_main'),
    reservedBalanceMinor: find('member_withdrawal_hold'),
    pendingDepositsMinor: totals.pending,
    totalDepositedMinor: totals.deposited,
    totalWithdrawnMinor: totals.withdrawn,
    totalReferralEarnedMinor: totals.referral,
    taskBalancesMinor: Object.fromEntries(TASK_MODULES.map(m => [m, find('member_task', m)])) as Record<TaskModule, string>,
    membershipActive: membership !== null,
    membershipActivatedAt: membership?.activated_at ?? null,
    membershipFeeMinor: config?.membershipFeeMinor ?? null,
  };
}

export interface TransactionRecord {
  id: string;
  kind: string;
  balance: string;
  amountMinor: string;
  currency: string;
  balanceAfterMinor: string;
  description: string;
  reference: string | null;
  createdAt: Date;
}

// The member's statement: every ledger entry on their main and task balances (holds are internal).
export async function getTransactions(db: Db, userId: number, limit = 50): Promise<TransactionRecord[]> {
  const list = await rows<{
    id: string; kind: string; module: string | null; side: string; normal_side: string; amount_minor: string; currency_code: string;
    balance_after_minor: string; memo: string; ref_id: string | null; created_at: Date;
  }>(
    db,
    `SELECT e.id, t.kind, a.module, e.side, a.normal_side, e.amount_minor, e.currency_code, e.balance_after_minor, t.memo, t.ref_id, e.created_at
     FROM ledger_entries e JOIN accounts a ON a.id = e.account_id JOIN ledger_transactions t ON t.id = e.transaction_id
     WHERE a.user_id = $1 AND a.kind IN ('member_main', 'member_task')
     ORDER BY e.id DESC LIMIT $2`,
    [userId, limit],
  );
  return list.map(e => ({
    id: e.id,
    kind: e.kind,
    balance: e.module ?? 'main',
    amountMinor: e.side === e.normal_side ? e.amount_minor : `-${e.amount_minor}`,
    currency: e.currency_code,
    balanceAfterMinor: e.balance_after_minor,
    description: e.memo,
    reference: e.ref_id,
    createdAt: e.created_at,
  }));
}

export const newReference = (prefix: string) => `${prefix}-${randomCode(8)}`;

// Pays the membership fee from the main balance to platform revenue and issues a receipt (D8). Membership
// fees are platform revenue (rule 1). Runs inside moneyTx.
export async function activateMembership(db: PoolClient, userId: number): Promise<{ alreadyActive: boolean; receiptNo: string; feeMinor: string; currency: string; activatedAt: Date; referralsRewarded: number }> {
  const member = await memberInfo(db, userId);
  await db.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
  const existing = await maybeOne<{ receipt_no: string; fee_minor: string; currency_code: string; activated_at: Date }>(
    db, 'SELECT receipt_no, fee_minor, currency_code, activated_at FROM memberships WHERE user_id = $1', [userId],
  );
  if (existing) {
    return { alreadyActive: true, receiptNo: existing.receipt_no, feeMinor: existing.fee_minor, currency: existing.currency_code, activatedAt: existing.activated_at, referralsRewarded: 0 };
  }
  requireActive(member);
  const config = await requireConfig(db, member.countryCode);
  const fee = BigInt(config.membershipFeeMinor);
  const main = await accountId(db, { kind: 'member_main', userId, currency: member.currency });
  const revenue = await accountId(db, { kind: 'platform_revenue', currency: member.currency });
  const receiptNo = newReference('MB');
  let txn: number;
  try {
    txn = await post(db, { kind: 'membership_fee', memo: 'Membership fee', refType: 'membership', refId: receiptNo, actorUserId: userId, legs: move(main, revenue, fee) });
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      throw badRequest('membership.insufficient_funds', 'Your main balance is below the membership fee. Make a deposit first.');
    }
    throw err;
  }
  const saved = await one<{ activated_at: Date }>(
    db,
    'INSERT INTO memberships (user_id, receipt_no, fee_minor, currency_code, ledger_transaction_id) VALUES ($1, $2, $3, $4, $5) RETURNING activated_at',
    [userId, receiptNo, fee.toString(), member.currency, txn],
  );
  // Multi-level referral rewards up the chain (levels 1 to 3), as before.
  const { distributedCount } = await distributeReferralRewards(db, userId);
  return { alreadyActive: false, receiptNo, feeMinor: fee.toString(), currency: member.currency, activatedAt: saved.activated_at, referralsRewarded: distributedCount };
}
