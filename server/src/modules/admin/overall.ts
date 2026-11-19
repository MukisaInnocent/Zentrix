import { Router } from 'express';
import type { Db } from '../../db/sql.js';
import { rows } from '../../db/sql.js';
import { providerAmountToMinor } from '../../providers/livepay.js';
import type { ProviderBalanceSnapshot } from '../../providers/provider-balance.js';
import type { Services } from '../../services.js';
import { requireStaff } from '../auth/middleware.js';
import { convert } from '../fx/service.js';

// Overall balance (owner, 2026-11-10): what the platform has received, spent and paid out, per currency and as one
// total in UGX at the latest rates, compared with the money really held, LivePay's own balance first, to show any
// deficit. Read only: nothing here moves money. Owner money sent in to cover losses is business money and counts
// in the totals; a positive position is a surplus.
//
// Cash figures come from the ledger's payment_clearing accounts (one per payment method), by transaction kind:
// money in is a debit there, money out a credit.

const RECEIVED = ['activation_fee', 'deposit'];
const FIGURES = ['received', 'ownerIn', 'withdrawn', 'providerCharges', 'ownerOut', 'other', 'withdrawalFees', 'referralRewards',
  'ledgerHeld', 'actualHeld', 'owedToMembers', 'position'] as const;
type Figure = (typeof FIGURES)[number];
type Figures = Record<Figure, bigint>;

export interface ChannelHolding {
  code: string;
  name: string;
  provider: string | null;
  ledgerMinor: string;
  // What is really there: LivePay's balance, the latest statement staff recorded, or (unverified) the ledger.
  actualMinor: string;
  actualSource: 'livepay' | 'statement' | 'ledger';
  actualAt: Date | string | null;
  differenceMinor: string;
}

export interface CurrencyOverall {
  currency: string;
  exponent: number;
  figures: Record<Figure, string>;
  // The same figures in UGX at the latest rate; null when the currency has no rate yet (left out of the total).
  ugx: Record<Figure, string> | null;
  livepay: { ledgerMinor: string; balanceMinor: string | null; differenceMinor: string | null } | null;
  channels: ChannelHolding[];
}

export interface OverallReport {
  generatedAt: string;
  livepayReadAt: string | null;
  livepayAvailable: boolean;
  currencies: CurrencyOverall[];
  totalUgx: Record<Figure, string>;
  // Currencies with money but no exchange rate, left out of the UGX total.
  notInTotal: string[];
}

const zero = (): Figures => Object.fromEntries(FIGURES.map(f => [f, 0n])) as Figures;
const asText = (f: Figures) => Object.fromEntries(FIGURES.map(k => [k, f[k].toString()])) as Record<Figure, string>;

// Converts a signed amount into UGX (rounding toward zero). Null without a rate.
async function toUgx(db: Db, amount: bigint, currency: string): Promise<bigint | null> {
  if (currency === 'UGX' || amount === 0n) return amount;
  const c = await convert(db, amount < 0n ? -amount : amount, currency, 'UGX');
  if (!c) return null;
  return amount < 0n ? -c.amountMinor : c.amountMinor;
}

export async function buildOverall(db: Db, livepay: ProviderBalanceSnapshot | null, now: Date): Promise<OverallReport> {
  const cash = await rows<{ currency_code: string; kind: string; side: string; total: string }>(
    db,
    `SELECT e.currency_code, t.kind, e.side, sum(e.amount_minor)::text AS total
     FROM ledger_entries e JOIN accounts a ON a.id = e.account_id JOIN ledger_transactions t ON t.id = e.transaction_id
     WHERE a.kind = 'payment_clearing' GROUP BY 1, 2, 3`,
  );
  const other = await rows<{ currency_code: string; withdrawal_fees: string; referral_rewards: string }>(
    db,
    `SELECT e.currency_code,
            coalesce(sum(e.amount_minor) FILTER (WHERE a.kind = 'fees' AND t.kind = 'withdrawal_paid' AND e.side = 'credit'), 0)::text AS withdrawal_fees,
            (coalesce(sum(e.amount_minor) FILTER (WHERE a.kind = 'member_main' AND t.kind = 'referral_bonus' AND e.side = 'credit'), 0)
             - coalesce(sum(e.amount_minor) FILTER (WHERE a.kind = 'member_main' AND t.kind = 'referral_reversal' AND e.side = 'debit'), 0))::text AS referral_rewards
     FROM ledger_entries e JOIN accounts a ON a.id = e.account_id JOIN ledger_transactions t ON t.id = e.transaction_id
     WHERE a.kind IN ('fees', 'member_main') AND t.kind IN ('withdrawal_paid', 'referral_bonus', 'referral_reversal')
     GROUP BY 1`,
  );
  const owed = await rows<{ currency_code: string; total: string }>(
    db,
    `SELECT currency_code, sum(balance_minor)::text AS total FROM accounts
     WHERE kind IN ('member_main', 'member_deposit', 'member_withdrawal_hold', 'member_aviator') GROUP BY 1`, // Aviator balances are owed too (2026-11-19)
  );
  const channels = await rows<{ code: string; name: string; provider: string | null; currency_code: string; ledger: string | null; statement: string | null; statement_at: Date | null }>(
    db,
    `SELECT c.code, c.name, c.provider, c.currency_code, a.balance_minor::text AS ledger, s.balance_minor::text AS statement, s.recorded_at AS statement_at
     FROM payment_channels c
     LEFT JOIN accounts a ON a.kind = 'payment_clearing' AND a.channel_id = c.id
     LEFT JOIN LATERAL (SELECT balance_minor, recorded_at FROM float_snapshots f WHERE f.channel_id = c.id ORDER BY f.id DESC LIMIT 1) s ON true
     ORDER BY c.currency_code, c.name`,
  );
  const exponents = new Map((await rows<{ code: string; exponent: number }>(db, 'SELECT code, exponent FROM currencies')).map(r => [r.code, r.exponent]));

  const currencies = [...new Set([...cash.map(c => c.currency_code), ...owed.filter(o => o.total !== '0').map(o => o.currency_code), ...channels.map(c => c.currency_code)])].sort();
  const totalUgx = zero();
  const notInTotal: string[] = [];
  const out: CurrencyOverall[] = [];
  for (const currency of currencies) {
    const exponent = exponents.get(currency) ?? 0;
    const f = zero();
    let net = 0n;
    for (const c of cash.filter(x => x.currency_code === currency)) {
      const amount = BigInt(c.total);
      const signed = c.side === 'debit' ? amount : -amount;
      net += signed;
      if (RECEIVED.includes(c.kind) && c.side === 'debit') f.received += amount;
      else if (c.kind === 'treasury_capital_in' && c.side === 'debit') f.ownerIn += amount;
      else if (c.kind === 'withdrawal_paid' && c.side === 'credit') f.withdrawn += amount;
      else if (c.kind === 'provider_charge' && c.side === 'credit') f.providerCharges += amount;
      else if (c.kind === 'treasury_owner_withdrawal' && c.side === 'credit') f.ownerOut += amount;
      else f.other += signed;
    }
    const o = other.find(x => x.currency_code === currency);
    f.withdrawalFees = BigInt(o?.withdrawal_fees ?? '0');
    f.referralRewards = BigInt(o?.referral_rewards ?? '0');
    f.owedToMembers = BigInt(owed.find(x => x.currency_code === currency)?.total ?? '0');

    // LivePay's balance stands for every LivePay method in this currency together (one LivePay account).
    const snapshotText = livepay?.balances.find(b => b.currency === currency)?.balance;
    const livepayBalance = snapshotText === undefined ? null : providerAmountToMinor(snapshotText, exponent);
    const own = channels.filter(c => c.currency_code === currency);
    const livepayLedger = own.filter(c => c.provider === 'livepay').reduce((s, c) => s + BigInt(c.ledger ?? '0'), 0n);
    const holdings: ChannelHolding[] = own.map(c => {
      const ledger = BigInt(c.ledger ?? '0');
      const isLivePay = c.provider === 'livepay';
      if (isLivePay && livepayBalance !== null) {
        return { code: c.code, name: c.name, provider: c.provider, ledgerMinor: ledger.toString(), actualMinor: ledger.toString(), actualSource: 'livepay', actualAt: livepay!.readAt, differenceMinor: '0' };
      }
      const actual = c.statement !== null ? BigInt(c.statement) : ledger;
      return {
        code: c.code, name: c.name, provider: c.provider, ledgerMinor: ledger.toString(), actualMinor: actual.toString(),
        actualSource: c.statement !== null ? 'statement' : 'ledger', actualAt: c.statement_at, differenceMinor: (actual - ledger).toString(),
      };
    });
    const nonLivePayActual = holdings.filter(h => h.actualSource !== 'livepay').reduce((s, h) => s + BigInt(h.actualMinor), 0n);
    f.ledgerHeld = own.reduce((s, c) => s + BigInt(c.ledger ?? '0'), 0n);
    f.actualHeld = nonLivePayActual + (livepayBalance ?? 0n);
    f.position = f.actualHeld - f.owedToMembers;
    // Cash moves add up to what the ledger says is held; anything else (a channel opened with a balance) shows as other.
    if (net !== f.ledgerHeld) f.other += f.ledgerHeld - net;

    let ugx: Figures | null = zero();
    for (const k of FIGURES) {
      const v = await toUgx(db, f[k], currency);
      if (v === null) { ugx = null; break; }
      ugx[k] = v;
    }
    if (ugx) for (const k of FIGURES) totalUgx[k] += ugx[k];
    else if (FIGURES.some(k => f[k] !== 0n)) notInTotal.push(currency);

    out.push({
      currency, exponent, figures: asText(f), ugx: ugx ? asText(ugx) : null,
      livepay: own.some(c => c.provider === 'livepay')
        ? { ledgerMinor: livepayLedger.toString(), balanceMinor: livepayBalance?.toString() ?? null, differenceMinor: livepayBalance === null ? null : (livepayBalance - livepayLedger).toString() }
        : null,
      channels: holdings,
    });
  }
  return {
    generatedAt: now.toISOString(), livepayReadAt: livepay?.readAt ?? null, livepayAvailable: livepay !== null,
    currencies: out, totalUgx: asText(totalUgx), notInTotal,
  };
}

export function overallAdminRouter(services: Services): Router {
  const router = Router();
  router.get('/', requireStaff('admin', 'finance'), async (_req, res) => {
    const livepay = services.providerBalance
      ? await services.providerBalance.latest().catch((err: unknown) => {
        services.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'LivePay balance could not be read');
        return null;
      })
      : null;
    res.json(await buildOverall(services.pool, livepay, services.now()));
  });
  return router;
}
