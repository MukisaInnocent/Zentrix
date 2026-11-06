import { randomInt } from 'node:crypto';
import type { PoolClient } from '../../db/pool.js';
import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';

// Aviator, brought from the owner's Aviator project (app/routes/game.py and wallet.py) as it is (owner, 2026-11-06).
// One shared round for everyone: an 8-second betting window, then the multiplier grows as 1.1^t seconds until the
// crash point drawn when the round was made; 3 seconds after the crash the next round opens. Players bet demo credits
// (no cash value). Amounts are hundredths of a credit.

export const BETTING_SECONDS = 8;
export const CRASH_DISPLAY_SECONDS = 3;
export const GROWTH_RATE = 1.1;
const GAME_CLOCK_LOCK_KEY = 0x41564941; // the project's advisory lock key
const MAX_AMOUNT = 9_999_999_999n; // 99,999,999.99 credits, as the project's Numeric(10, 2)

// As generate_crash_point: a roll of 0.00 to 99.99; 99 and above (1%) crashes at once, otherwise 100 / (100 - roll).
export function generateCrashPoint(roll = randomInt(0, 10_000) / 100): number {
  if (roll >= 99) return 1.0;
  return Math.round((100 / (100 - roll)) * 100) / 100;
}

interface Round { id: string; crash_point: string; start_time: Date; status: 'waiting' | 'active' | 'crashed' }
interface Bet { id: string; round_id: string; user_id: string; amount: string; multiplier: number; result: 'pending' | 'win' | 'loss'; payout: string }

const crashPoint = (r: Round) => Number(r.crash_point);
const crashTime = (r: Round) => new Date(r.start_time.getTime() + (crashPoint(r) <= 1 ? 0 : (Math.log(crashPoint(r)) / Math.log(GROWTH_RATE)) * 1000));
const currentMultiplier = (r: Round, now: Date) => GROWTH_RATE ** Math.max(0, (now.getTime() - r.start_time.getTime()) / 1000);
const plusSeconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000);

// Credits as the project's parse_amount: positive, at most two decimal places. Returns hundredths.
export function parseAmount(raw: unknown): bigint | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const text = String(raw).trim();
  const m = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return null;
  const value = BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
  return value > 0n && value <= MAX_AMOUNT ? value : null;
}
const AMOUNT_ERROR = 'Enter a positive amount with no more than two decimal places';
const credits = (hundredths: bigint | string) => Number(hundredths) / 100;

function needsTransition(r: Round | null, now: Date): boolean {
  if (!r) return true;
  if (r.status === 'crashed') return now >= plusSeconds(crashTime(r), CRASH_DISPLAY_SECONDS);
  if (r.status === 'waiting') return now >= r.start_time;
  return now >= crashTime(r);
}

async function settleLosses(db: Db, r: Round): Promise<void> {
  await db.query(`UPDATE aviator_bets SET result = 'loss', multiplier = $2, payout = 0 WHERE round_id = $1 AND result = 'pending'`, [r.id, crashPoint(r)]);
}

// Moves the latest round forward; the caller holds the game clock lock.
async function advanceRound(db: Db, now: Date): Promise<Round> {
  let r = await maybeOne<Round>(db, 'SELECT * FROM aviator_rounds ORDER BY id DESC LIMIT 1 FOR UPDATE');
  if (!r || (r.status === 'crashed' && now >= plusSeconds(crashTime(r), CRASH_DISPLAY_SECONDS))) {
    r = await one<Round>(db, `INSERT INTO aviator_rounds (crash_point, start_time, status) VALUES ($1, $2, 'waiting') RETURNING *`,
      [generateCrashPoint(), plusSeconds(now, BETTING_SECONDS)]);
  }
  if (r.status === 'waiting' && now >= r.start_time) r = await one<Round>(db, `UPDATE aviator_rounds SET status = 'active' WHERE id = $1 RETURNING *`, [r.id]);
  if (r.status === 'active' && now >= crashTime(r)) {
    r = await one<Round>(db, `UPDATE aviator_rounds SET status = 'crashed' WHERE id = $1 RETURNING *`, [r.id]);
    await settleLosses(db, r);
  }
  return r;
}

async function userBet(db: Db, r: Round, userId: number) {
  const bet = await maybeOne<Bet>(db, 'SELECT * FROM aviator_bets WHERE round_id = $1 AND user_id = $2', [r.id, userId]);
  if (!bet) return null;
  return { id: bet.id, amount: credits(bet.amount), result: bet.result, multiplier: bet.multiplier, payout: credits(bet.payout) };
}

async function roundState(db: Db, r: Round, now: Date, userId: number) {
  const state: Record<string, unknown> = {
    round_id: Number(r.id), status: r.status, start_time: r.start_time.toISOString(), server_time: now.toISOString(),
  };
  if (r.status === 'waiting') {
    state.starts_in = Math.max(0, Math.ceil((r.start_time.getTime() - now.getTime()) / 1000));
    state.multiplier = 1.0;
  } else if (r.status === 'active') {
    state.multiplier = Math.round(currentMultiplier(r, now) * 100) / 100;
  } else {
    state.multiplier = crashPoint(r);
    state.crash_point = crashPoint(r);
    state.next_round_in = Math.max(0, Math.ceil((plusSeconds(crashTime(r), CRASH_DISPLAY_SECONDS).getTime() - now.getTime()) / 1000));
  }
  const bet = await userBet(db, r, userId);
  if (bet) state.my_bet = bet;
  return state;
}

// GET state: a plain read first, so polling members do not block each other; a transition takes the clock lock.
export async function gameState(pool: { connect(): Promise<PoolClient> }, read: Db, userId: number, now: Date) {
  let r = await maybeOne<Round>(read, 'SELECT * FROM aviator_rounds ORDER BY id DESC LIMIT 1');
  if (needsTransition(r, now)) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock($1)', [GAME_CLOCK_LOCK_KEY]);
      r = await advanceRound(db, now);
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    } finally {
      db.release();
    }
  }
  return roundState(read, r!, now, userId);
}

export async function history(db: Db) {
  const list = await rows<{ id: string; crash_point: string }>(db, `SELECT id, crash_point FROM aviator_rounds WHERE status = 'crashed' ORDER BY id DESC LIMIT 10`);
  return list.map(r => ({ round_id: Number(r.id), crash_point: Number(r.crash_point) }));
}

async function wallet(db: Db, userId: number, lock = false): Promise<bigint> {
  await db.query('INSERT INTO aviator_wallets (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
  return BigInt((await one<{ balance: string }>(db, `SELECT balance FROM aviator_wallets WHERE user_id = $1${lock ? ' FOR UPDATE' : ''}`, [userId])).balance);
}

export async function balance(db: Db, userId: number) {
  return { balance: credits(await wallet(db, userId)) };
}

export async function placeBet(db: Db, userId: number, rawAmount: unknown, now: Date) {
  const amount = parseAmount(rawAmount);
  if (amount === null) throw badRequest('validation_failed', AMOUNT_ERROR, { amount: [AMOUNT_ERROR] });
  const r = await maybeOne<Round>(db, 'SELECT * FROM aviator_rounds ORDER BY id DESC LIMIT 1 FOR UPDATE');
  if (!r || r.status !== 'waiting' || now >= r.start_time) throw conflict('aviator.betting_closed', 'Bets are accepted only during the betting window');
  const held = await wallet(db, userId, true);
  if (held < amount) throw badRequest('aviator.insufficient', 'Insufficient demo credits');
  if (await maybeOne(db, 'SELECT 1 FROM aviator_bets WHERE round_id = $1 AND user_id = $2', [r.id, userId])) {
    throw conflict('aviator.already_bet', 'You already placed a bet in this round');
  }
  await db.query('UPDATE aviator_wallets SET balance = balance - $2, updated_at = now() WHERE user_id = $1', [userId, amount.toString()]);
  const bet = await one<{ id: string }>(db, 'INSERT INTO aviator_bets (round_id, user_id, amount) VALUES ($1, $2, $3) RETURNING id', [r.id, userId, amount.toString()]);
  return { message: 'Demo bet placed', bet_id: Number(bet.id), round_id: Number(r.id), balance: credits(held - amount) };
}

export async function cashout(db: Db, userId: number, rawBetId: unknown, now: Date) {
  const betId = Number(rawBetId);
  if (!Number.isInteger(betId) || betId <= 0) throw badRequest('validation_failed', 'A valid bet ID is required');
  const found = await maybeOne<Bet>(db, 'SELECT * FROM aviator_bets WHERE id = $1 AND user_id = $2', [betId, userId]);
  if (!found) throw notFound('aviator.no_bet', 'Bet not found for this account');
  const r = await maybeOne<Round>(db, 'SELECT * FROM aviator_rounds WHERE id = $1 FOR UPDATE', [found.round_id]);
  const bet = await maybeOne<Bet>(db, 'SELECT * FROM aviator_bets WHERE id = $1 AND user_id = $2 FOR UPDATE', [betId, userId]);
  if (!r || !bet) throw notFound('aviator.no_round', 'Bet round no longer exists');
  if (bet.result !== 'pending') throw conflict('aviator.settled', 'This bet has already been settled');
  if (r.status !== 'active') throw conflict('aviator.not_flying', 'The round is not in flight');
  if (now >= crashTime(r)) {
    await db.query(`UPDATE aviator_rounds SET status = 'crashed' WHERE id = $1`, [r.id]);
    await settleLosses(db, r);
    return { crashed: true as const };
  }
  const multiplier = currentMultiplier(r, now);
  const held = await wallet(db, userId, true);
  const payout = BigInt(Math.round(Number(bet.amount) * multiplier)); // round half up to the hundredth, as the project
  await db.query(`UPDATE aviator_bets SET result = 'win', multiplier = $2, payout = $3 WHERE id = $1`, [bet.id, multiplier, payout.toString()]);
  await db.query('UPDATE aviator_wallets SET balance = balance + $2, updated_at = now() WHERE user_id = $1', [userId, payout.toString()]);
  return { crashed: false as const, message: 'Cashout successful', payout: credits(payout), multiplier, balance: credits(held + payout) };
}

// Credit requests (wallet.py): a deposit asks for demo credits; a withdrawal asks to remove them. The balance is not
// changed until staff approve; a withdrawal is checked again then.
export async function requestCredits(db: Db, userId: number, kind: 'deposit' | 'withdrawal', rawAmount: unknown) {
  const amount = parseAmount(rawAmount);
  if (amount === null) throw badRequest('validation_failed', AMOUNT_ERROR, { amount: [AMOUNT_ERROR] });
  if (kind === 'withdrawal' && (await wallet(db, userId)) < amount) throw badRequest('aviator.insufficient', 'Insufficient balance');
  await db.query('INSERT INTO aviator_requests (user_id, kind, amount) VALUES ($1, $2, $3)', [userId, kind, amount.toString()]);
  return { message: `${kind === 'deposit' ? 'Deposit' : 'Withdrawal'} request submitted successfully` };
}

export async function transactions(db: Db, userId: number) {
  const list = await rows<{ kind: string; amount: string; status: string; created_at: Date }>(
    db, 'SELECT kind, amount, status, created_at FROM aviator_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [userId],
  );
  return list.map(t => ({ type: t.kind, amount: credits(t.amount), status: t.status, date: t.created_at.toISOString() }));
}

export async function listRequests(db: Db) {
  const list = await rows<{ public_id: string; username: string; kind: string; amount: string; status: string; created_at: Date; balance: string | null }>(
    db,
    `SELECT r.public_id, u.username, r.kind, r.amount, r.status, r.created_at, w.balance
     FROM aviator_requests r JOIN users u ON u.id = r.user_id LEFT JOIN aviator_wallets w ON w.user_id = r.user_id
     ORDER BY (r.status = 'pending') DESC, r.id DESC LIMIT 200`,
  );
  return list.map(r => ({ id: r.public_id, username: r.username, kind: r.kind, amount: credits(r.amount), status: r.status, createdAt: r.created_at, balance: credits(r.balance ?? '0') }));
}

export async function processRequest(db: Db, staffId: number, publicId: string, action: 'approve' | 'reject') {
  const r = await maybeOne<{ id: string; user_id: string; kind: string; amount: string; status: string }>(
    db, 'SELECT id, user_id, kind, amount, status FROM aviator_requests WHERE public_id = $1 FOR UPDATE', [publicId],
  );
  if (!r) throw notFound();
  if (r.status !== 'pending') throw conflict('aviator.processed', 'Request already processed');
  if (action === 'approve') {
    const held = await wallet(db, Number(r.user_id), true);
    if (r.kind === 'withdrawal' && held < BigInt(r.amount)) throw badRequest('aviator.insufficient', 'User has insufficient balance for approval');
    await db.query(`UPDATE aviator_wallets SET balance = balance ${r.kind === 'deposit' ? '+' : '-'} $2, updated_at = now() WHERE user_id = $1`, [r.user_id, r.amount]);
  }
  await db.query('UPDATE aviator_requests SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1', [r.id, action === 'approve' ? 'approved' : 'rejected', staffId]);
  return { kind: r.kind, amount: credits(r.amount), status: action === 'approve' ? 'approved' : 'rejected' };
}
