import type { PoolClient } from '../../db/pool.js';
import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';
import { randomCode } from '../../lib/crypto.js';
import { badRequest, forbidden } from '../../lib/errors.js';
import { currentCountryConfig, type CountryConfig } from '../countries/service.js';
import { accountId, balanceOf, move, post, TASK_MODULES, type Leg, type TaskModule } from '../ledger/ledger.js';

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
  // Balance: referral money only (member_main), less any debt from a moved referral reward, so it can be below
  // zero. Deposit balance: confirmed deposits, Pay For Client money received and voucher value above the fee
  // (member_deposit). Spendable: both, used for vouchers and Pay For Client.
  availableBalanceMinor: string;
  debtMinor: string;
  depositBalanceMinor: string;
  spendableMinor: string;
  reservedBalanceMinor: string;
  pendingDepositsMinor: string;
  totalDepositedMinor: string;
  totalWithdrawnMinor: string;
  totalReferralEarnedMinor: string;
  taskBalancesMinor: Record<TaskModule, string>;
  membershipActive: boolean;
  membershipActivatedAt: Date | null;
  membershipFeeMinor: string | null;
  // Dashboard figures (owner, 2026-10-25). Balance is the main balance, which holds referral money only.
  // Expenses are the activation fee paid. Total earnings are referral rewards plus task rewards. Net earnings
  // are total earnings minus expenses.
  expensesMinor: string;
  referralEarningsMinor: string;
  taskEarningsMinor: string;
  totalEarningsMinor: string;
  netEarningsMinor: string;
}

export async function getWalletSummary(db: Db, userId: number): Promise<WalletSummary> {
  const member = await memberInfo(db, userId);
  const [balances, totals, membership, config] = await Promise.all([
    rows<{ kind: string; module: string | null; balance_minor: string }>(
      db, 'SELECT kind, module, balance_minor FROM accounts WHERE user_id = $1 AND currency_code = $2', [userId, member.currency],
    ),
    one<{ deposited: string; pending: string; withdrawn: string; referral: string; tasks: string }>(
      db,
      `SELECT (SELECT coalesce(sum(credited_amount_minor), 0) FROM deposits WHERE user_id = $1 AND status = 'confirmed' AND purpose = 'wallet')::text AS deposited,
              (SELECT coalesce(sum(reward_minor), 0) FROM task_submissions WHERE user_id = $1 AND status = 'approved')::text AS tasks,
              (SELECT coalesce(sum(claimed_amount_minor), 0) FROM deposits WHERE user_id = $1 AND status = 'pending')::text AS pending,
              (SELECT coalesce(sum(amount_minor), 0) FROM withdrawals WHERE user_id = $1 AND status = 'paid')::text AS withdrawn,
              (SELECT coalesce(sum(amount_minor), 0) FROM referral_rewards WHERE referrer_user_id = $1 AND status = 'credited')::text AS referral`,
      [userId],
    ),
    maybeOne<{ activated_at: Date; fee_minor: string }>(db, 'SELECT activated_at, fee_minor FROM memberships WHERE user_id = $1', [userId]),
    currentCountryConfig(db, member.countryCode),
  ]);
  const expenses = BigInt(membership?.fee_minor ?? '0');
  const totalEarnings = BigInt(totals.referral) + BigInt(totals.tasks);
  const find = (kind: string, module: string | null = null) =>
    balances.find(b => b.kind === kind && b.module === module)?.balance_minor ?? '0';
  const balance = BigInt(find('member_main')) - BigInt(find('member_debt'));
  return {
    currency: member.currency,
    availableBalanceMinor: balance.toString(),
    debtMinor: find('member_debt'),
    depositBalanceMinor: find('member_deposit'),
    spendableMinor: (balance + BigInt(find('member_deposit'))).toString(),
    reservedBalanceMinor: find('member_withdrawal_hold'),
    pendingDepositsMinor: totals.pending,
    totalDepositedMinor: totals.deposited,
    totalWithdrawnMinor: totals.withdrawn,
    totalReferralEarnedMinor: totals.referral,
    taskBalancesMinor: Object.fromEntries(TASK_MODULES.map(m => [m, find('member_task', m)])) as Record<TaskModule, string>,
    membershipActive: membership !== null,
    membershipActivatedAt: membership?.activated_at ?? null,
    membershipFeeMinor: config?.membershipFeeMinor ?? null,
    expensesMinor: expenses.toString(),
    referralEarningsMinor: totals.referral,
    taskEarningsMinor: totals.tasks,
    totalEarningsMinor: totalEarnings.toString(),
    netEarningsMinor: (totalEarnings - expenses).toString(),
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
    id: string; kind: string; account_kind: string; module: string | null; side: string; normal_side: string; amount_minor: string;
    currency_code: string; balance_after_minor: string; memo: string; ref_id: string | null; created_at: Date;
  }>(
    db,
    `SELECT e.id, t.kind, a.kind AS account_kind, a.module, e.side, a.normal_side, e.amount_minor, e.currency_code, e.balance_after_minor,
            t.memo, t.ref_id, e.created_at
     FROM ledger_entries e JOIN accounts a ON a.id = e.account_id JOIN ledger_transactions t ON t.id = e.transaction_id
     WHERE a.user_id = $1 AND a.kind IN ('member_main', 'member_deposit', 'member_task', 'member_debt')
     ORDER BY e.id DESC LIMIT $2`,
    [userId, limit],
  );
  return list.map(e => {
    // A debt is shown from the member's side: it growing is money out, and its balance is below zero.
    const debt = e.account_kind === 'member_debt';
    const grows = e.side === e.normal_side;
    return {
      id: e.id,
      kind: e.kind,
      balance: e.module ?? (debt ? 'debt' : e.account_kind === 'member_deposit' ? 'deposit' : 'main'),
      amountMinor: grows !== debt ? e.amount_minor : `-${e.amount_minor}`,
      currency: e.currency_code,
      balanceAfterMinor: debt && e.balance_after_minor !== '0' ? `-${e.balance_after_minor}` : e.balance_after_minor,
      description: e.memo,
      reference: e.ref_id,
      createdAt: e.created_at,
    };
  });
}

// Repays a member's debt (from a moved referral reward) out of their balance, as far as the balance allows.
// Called whenever money reaches the balance, and before the balance is spent or withdrawn, so the balance is
// empty for as long as any debt remains.
export async function settleDebt(db: PoolClient, userId: number, currency: string): Promise<void> {
  const debt = await accountId(db, { kind: 'member_debt', userId, currency });
  const owed = await balanceOf(db, debt);
  if (owed === 0n) return;
  const main = await accountId(db, { kind: 'member_main', userId, currency });
  const held = await balanceOf(db, main);
  const repay = held < owed ? held : owed;
  if (repay === 0n) return;
  await post(db, { kind: 'debt_repayment', memo: 'Repayment of a moved referral reward', refType: 'debt', legs: move(main, debt, repay) });
}

export const newReference = (prefix: string) => `${prefix}-${randomCode(8)}`;

// Legs that pay `amountMinor` to `to` from the member's own money: the deposit balance first, then the balance
// (referral money) for the rest. A shortfall surfaces as InsufficientFundsError on the balance leg.
export async function spendLegs(db: PoolClient, userId: number, currency: string, amountMinor: bigint, to: number): Promise<Leg[]> {
  await settleDebt(db, userId, currency);
  const deposit = await accountId(db, { kind: 'member_deposit', userId, currency });
  const main = await accountId(db, { kind: 'member_main', userId, currency });
  const held = await balanceOf(db, deposit);
  const fromDeposit = held < amountMinor ? held : amountMinor;
  const fromMain = amountMinor - fromDeposit;
  const legs: Leg[] = [];
  if (fromDeposit > 0n) legs.push(...move(deposit, to, fromDeposit));
  if (fromMain > 0n) legs.push(...move(main, to, fromMain));
  return legs;
}
