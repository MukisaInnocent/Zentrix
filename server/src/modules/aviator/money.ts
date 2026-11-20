import type { PoolClient } from '../../db/pool.js';
import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { MoneyFormatError, toDecimalString, toMinor } from '../../lib/money.js';
import { accountId, balanceOf, InsufficientFundsError, move, post } from '../ledger/ledger.js';
import { spendLegs } from '../wallet/service.js';

// Aviator with real money (owner, 2026-11-19; licence NLGRB-BMTOL-26-0290, Uganda; migration 0043). Every stake,
// payout and transfer goes through the ledger:
//   member_aviator  the member's Aviator balance (owed to the member; counted in the balance check, rule 6);
//   aviator_house   the company's Aviator money per currency: lost stakes stay there, winnings are paid from it.
// The owner decided that Aviator is house-banked: what players lose is the company's profit and what they win is the
// company's loss (an exception to rule 1 for Aviator only). Bets have no minimum or maximum: a member may bet up to
// the whole Aviator balance (owner). The house limit (service.ts, setLimit) keeps the house at or above the floor.
// aviator_bets and aviator_requests keep amounts in hundredths of the major unit; the ledger holds minor units.

export interface PlayCurrency { code: string; exponent: number; floorMinor: bigint }

const scale = (exponent: number) => 10n ** BigInt(2 - exponent);
export const toHundredths = (minor: bigint, exponent: number) => minor * scale(exponent);
export const fromHundredths = (hundredths: bigint, exponent: number) => hundredths / scale(exponent);
export const major = (minor: bigint, exponent: number) => Number(toDecimalString(minor, exponent));

interface CurrencyRow { currency_code: string; enabled: boolean; floor_minor: string; exponent: number }

export async function currencyConfig(db: Db, code: string): Promise<CurrencyRow | null> {
  return maybeOne<CurrencyRow>(db,
    `SELECT a.currency_code, a.enabled, a.floor_minor, c.exponent FROM aviator_currencies a JOIN currencies c ON c.code = a.currency_code
     WHERE a.currency_code = $1`, [code]);
}

// The member's currency when Aviator plays for real money in it, otherwise null.
export async function playCurrency(db: Db, userId: number): Promise<PlayCurrency | null> {
  const row = await maybeOne<CurrencyRow>(db,
    `SELECT a.currency_code, a.enabled, a.floor_minor, c.exponent FROM users u
     JOIN aviator_currencies a ON a.currency_code = u.currency_code AND a.enabled JOIN currencies c ON c.code = a.currency_code
     WHERE u.id = $1`, [userId]);
  return row && row.exponent <= 2 ? { code: row.currency_code, exponent: row.exponent, floorMinor: BigInt(row.floor_minor) } : null;
}

// The member's own currency, whether or not Aviator plays in it: money can always be moved back out (security
// review, 2026-11-19: switching a currency off must not trap balances).
async function ownCurrency(db: Db, userId: number): Promise<PlayCurrency> {
  const row = await one<{ currency_code: string; exponent: number }>(db,
    'SELECT u.currency_code, c.exponent FROM users u JOIN currencies c ON c.code = u.currency_code WHERE u.id = $1', [userId]);
  return { code: row.currency_code, exponent: row.exponent, floorMinor: 0n };
}

export const UNAVAILABLE = 'Aviator is not available in your country yet.';
export async function requireCurrency(db: Db, userId: number): Promise<PlayCurrency> {
  const c = await playCurrency(db, userId);
  if (!c) throw conflict('aviator.unavailable', UNAVAILABLE);
  return c;
}

// An amount the member typed, in minor units of the currency. Zero only where `allowZero`.
export function parseMoney(raw: unknown, exponent: number, allowZero = false): bigint {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : '';
  try {
    const v = toMinor(text, exponent);
    if (v > 1_000_000_000_000n) throw badRequest('validation_failed', 'That amount is too large', { amount: ['That amount is too large'] });
    if (v > 0n || (allowZero && v === 0n)) return v;
  } catch (err) {
    if (!(err instanceof MoneyFormatError)) throw err;
    throw badRequest('validation_failed', err.message, { amount: [err.message] });
  }
  throw badRequest('validation_failed', 'Enter an amount above zero', { amount: ['Enter an amount above zero'] });
}

export const walletAccount = (db: Db, userId: number, currency: string) => accountId(db, { kind: 'member_aviator', userId, currency });
export const houseAccount = (db: Db, currency: string) => accountId(db, { kind: 'aviator_house', currency });

export async function walletBalance(db: Db, userId: number) {
  const cur = await playCurrency(db, userId);
  const own = cur ?? await ownCurrency(db, userId);
  const held = await maybeOne<{ balance_minor: string }>(db, `SELECT balance_minor FROM accounts WHERE kind = 'member_aviator' AND user_id = $1 AND currency_code = $2`, [userId, own.code]);
  const balance = own.exponent <= 2 ? major(BigInt(held?.balance_minor ?? '0'), own.exponent) : 0;
  return { balance, withdrawable: balance, currency: own.code, exponent: own.exponent, available: Boolean(cur) };
}

// Money in: from the deposit balance first, then the main balance (owner, 2026-11-19). Money out: to the main
// balance, from which the member withdraws as usual.
export async function transfer(db: PoolClient, userId: number, direction: 'in' | 'out', raw: unknown) {
  const cur = direction === 'in' ? await requireCurrency(db, userId) : await ownCurrency(db, userId);
  const amount = parseMoney(raw, cur.exponent);
  const wallet = await walletAccount(db, userId, cur.code);
  const before = await balanceOf(db, wallet);
  let txn: number;
  try {
    if (direction === 'in') {
      const legs = await spendLegs(db, userId, cur.code, amount, wallet);
      txn = await post(db, { kind: 'aviator_transfer_in', memo: 'Money moved into Aviator', refType: 'aviator_transfer', refId: String(userId), actorUserId: userId, legs });
    } else {
      const main = await accountId(db, { kind: 'member_main', userId, currency: cur.code });
      txn = await post(db, { kind: 'aviator_transfer_out', memo: 'Money moved from Aviator to the main balance', refType: 'aviator_transfer', refId: String(userId), actorUserId: userId, legs: move(wallet, main, amount) });
    }
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      throw badRequest('aviator.insufficient', direction === 'in' ? 'Your deposit and main balances are too low for this.' : 'Your Aviator balance is too low for this.');
    }
    throw err;
  }
  const after = await balanceOf(db, wallet);
  await db.query(
    `INSERT INTO aviator_requests (user_id, kind, amount, status, balance_before, balance_after, decided_at, currency_code, ledger_txn)
     VALUES ($1, $2, $3, 'completed', $4, $5, now(), $6, $7)`,
    [userId, direction === 'in' ? 'deposit' : 'withdrawal', toHundredths(amount, cur.exponent).toString(), toHundredths(before, cur.exponent).toString(),
      toHundredths(after, cur.exponent).toString(), cur.code, txn],
  );
  return {
    message: direction === 'in' ? 'Money added to your Aviator balance' : 'Money moved to your main balance. You can withdraw it from the Withdraw page.',
    balance: major(after, cur.exponent), currency: cur.code,
  };
}

// ----- Staff console -----

export async function moneyOverview(db: Db) {
  const list = await rows<{ currency_code: string; enabled: boolean; floor_minor: string; exponent: number; updated_at: Date }>(db,
    `SELECT a.currency_code, a.enabled, a.floor_minor, c.exponent, a.updated_at FROM aviator_currencies a JOIN currencies c ON c.code = a.currency_code
     ORDER BY a.enabled DESC, a.currency_code`);
  const out = [];
  for (const c of list) {
    const house = await maybeOne<{ balance_minor: string }>(db, `SELECT balance_minor FROM accounts WHERE kind = 'aviator_house' AND currency_code = $1`, [c.currency_code]);
    const wallets = await one<{ total: string | null; players: string }>(db,
      `SELECT sum(balance_minor) AS total, count(*) FILTER (WHERE balance_minor > 0) AS players FROM accounts WHERE kind = 'member_aviator' AND currency_code = $1`, [c.currency_code]);
    const moves = await one<{ moved_in: string | null; moved_out: string | null }>(db,
      `SELECT sum(amount) FILTER (WHERE kind = 'deposit') AS moved_in, sum(amount) FILTER (WHERE kind = 'withdrawal') AS moved_out
       FROM aviator_requests WHERE currency_code = $1`, [c.currency_code]);
    const play = await one<{ staked: string | null; paid: string | null; in_flight: string | null }>(db,
      `SELECT sum(amount) FILTER (WHERE result IN ('win', 'loss')) AS staked, sum(payout) FILTER (WHERE result IN ('win', 'loss')) AS paid,
              sum(amount) FILTER (WHERE result = 'pending') AS in_flight
       FROM aviator_bets WHERE currency_code = $1`, [c.currency_code]);
    const h = (v: string | null) => Number(BigInt(v ?? '0')) / 100;
    const staked = h(play.staked);
    const paid = h(play.paid);
    out.push({
      currency: c.currency_code, enabled: c.enabled, playable: c.exponent <= 2, updatedAt: c.updated_at,
      floor: major(BigInt(c.floor_minor), c.exponent), house: major(BigInt(house?.balance_minor ?? '0'), c.exponent),
      memberBalances: major(BigInt(wallets.total ?? '0'), c.exponent), playersWithBalance: Number(wallets.players),
      movedIn: h(moves.moved_in), movedOut: h(moves.moved_out), staked, paid, inFlight: h(play.in_flight),
      // What players lost minus what they won: the company's Aviator result.
      companyResult: Math.round((staked - paid) * 100) / 100,
    });
  }
  return { currencies: out };
}

async function refuseWhileInFlight(db: Db, code: string, message: string) {
  await db.query('SELECT id FROM aviator_rounds ORDER BY id DESC LIMIT 1 FOR UPDATE');
  if (await maybeOne(db, `SELECT 1 FROM aviator_bets WHERE currency_code = $1 AND result = 'pending' LIMIT 1`, [code])) {
    throw conflict('aviator.bets_in_flight', message);
  }
}

export async function setCurrency(db: Db, staffId: number, code: string, input: { enabled?: boolean; floor?: string | number }) {
  const c = await maybeOne<{ exponent: number }>(db, 'SELECT exponent FROM currencies WHERE code = $1', [code]);
  if (!c) throw notFound('aviator.no_currency', 'Unknown currency');
  const before = await currencyConfig(db, code);
  const floor = input.floor === undefined ? (before ? BigInt(before.floor_minor) : 0n) : parseMoney(input.floor, c.exponent, true);
  const enabled = input.enabled ?? before?.enabled ?? false;
  if (before && floor > BigInt(before.floor_minor)) await refuseWhileInFlight(db, code, 'Wait until no bets are in the air before raising the floor.');
  if (enabled && c.exponent > 2) throw badRequest('aviator.currency_decimals', 'Aviator plays only in currencies with at most 2 decimal places.');
  if (enabled) {
    const other = await maybeOne<{ currency_code: string }>(db, 'SELECT currency_code FROM aviator_currencies WHERE enabled AND currency_code <> $1', [code]);
    if (other) throw conflict('aviator.one_currency', `Real money is already on in ${other.currency_code}. One currency at a time for now.`);
  }
  await db.query(
    `INSERT INTO aviator_currencies (currency_code, enabled, floor_minor, updated_at, updated_by) VALUES ($1, $2, $3, now(), $4)
     ON CONFLICT (currency_code) DO UPDATE SET enabled = $2, floor_minor = $3, updated_at = now(), updated_by = $4`,
    [code, enabled, floor.toString(), staffId]);
  return {
    before: before ? { enabled: before.enabled, floor: major(BigInt(before.floor_minor), c.exponent) } : null,
    after: { enabled, floor: major(floor, c.exponent) },
  };
}

// House money: an admin moves platform revenue into the Aviator house, or takes it back, never below the floor.
export async function moveHouse(db: PoolClient, staffId: number, code: string, direction: 'fund' | 'return', raw: unknown, reason: string) {
  const cfg = await currencyConfig(db, code);
  if (!cfg) throw notFound('aviator.no_currency', 'Set up this currency for Aviator first');
  const why = reason.trim();
  if (why.length < 3 || why.length > 200) throw badRequest('validation_failed', 'Give a reason (3-200 characters); it is kept in the audit log', { reason: ['3 to 200 characters'] });
  const amount = parseMoney(raw, cfg.exponent);
  // Taking money back while bets are in the air could leave a winner unpaid (security review, 2026-11-19). The round
  // lock orders this after any bet or cash-out in progress.
  if (direction === 'return') await refuseWhileInFlight(db, code, 'Wait until no bets are in the air before taking house money back.');
  const house = await houseAccount(db, code);
  const revenue = await accountId(db, { kind: 'platform_revenue', currency: code });
  const before = await balanceOf(db, house);
  if (direction === 'return' && before - amount < BigInt(cfg.floor_minor)) {
    throw badRequest('aviator.below_floor', `The house money cannot go below its floor (${toDecimalString(BigInt(cfg.floor_minor), cfg.exponent)} ${code}).`);
  }
  try {
    await post(db, {
      kind: direction === 'fund' ? 'aviator_house_fund' : 'aviator_house_return', memo: why, refType: 'aviator_house', refId: code, actorUserId: staffId,
      legs: direction === 'fund' ? move(revenue, house, amount) : move(house, revenue, amount),
    });
  } catch (err) {
    if (err instanceof InsufficientFundsError) throw badRequest('aviator.insufficient', direction === 'fund' ? 'Platform revenue is too low for this.' : 'The house money is too low for this.');
    throw err;
  }
  const after = await balanceOf(db, house);
  return { currency: code, direction, amount: major(amount, cfg.exponent), before: major(before, cfg.exponent), after: major(after, cfg.exponent), reason: why };
}
