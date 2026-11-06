import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { PoolClient } from '../../db/pool.js';
import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';

// Aviator, brought from the owner's Aviator project (app/routes/game.py, wallet.py, game_settings.py) as it is
// (owner, 2026-11-06; updated 2026-11-06, later). One shared round for everyone: a betting window, then the multiplier grows
// as growth_rate^t seconds until the round's crash point; after a short pause the next round opens. Admins edit the
// timing, house edge, bet limits and a pause switch. Crash points are provably fair: each round's secret seed is
// hashed and the hash shown while members bet, and the seed is revealed after the crash. Players use demo credits
// (no cash value). Amounts are hundredths of a credit.

const GAME_CLOCK_LOCK_KEY = 0x41564941; // the project's advisory lock key
const MAX_AMOUNT = 9_999_999_999n; // 99,999,999.99 credits, as the project's Numeric(10, 2)
export const MAX_CRASH_POINT = 10000;
const FAIRNESS_MESSAGE = 'aviator-demo-crash';
export const FAIRNESS_FORMULA =
  'r = int(first 13 hex chars of HMAC_SHA256(key=server_seed, msg="aviator-demo-crash"), 16) / 2^52; '
  + 'crash = clamp(floor((1 - house_edge) / (1 - r) * 100) / 100, 1.00, 10000)';
const DEFAULT_GROWTH = 1.1;

export const seedHash = (seed: string) => createHash('sha256').update(seed, 'ascii').digest('hex');

// As generate_crash_point: r is uniform in [0, 1) and crash = (1 - edge) / (1 - r), floored to cents, so every
// cash-out target returns (1 - edge) of the stake on average.
export function generateCrashPoint(serverSeed: string, houseEdge: number): number {
  const digest = createHmac('sha256', Buffer.from(serverSeed, 'ascii')).update(FAIRNESS_MESSAGE).digest('hex');
  const r = parseInt(digest.slice(0, 13), 16) / 2 ** 52;
  const crash = Math.floor(((1 - houseEdge) / (1 - r)) * 100) / 100;
  return Math.min(MAX_CRASH_POINT, Math.max(1.0, crash));
}

export interface Settings {
  betting_seconds: number; crash_display_seconds: number; growth_rate: number; house_edge: number;
  min_bet: string; max_bet: string; max_win: string; paused: boolean; pause_message: string | null; updated_at: Date;
}
interface Round {
  id: string; crash_point: string; start_time: Date; status: 'waiting' | 'active' | 'crashed';
  server_seed: string | null; hash: string | null; house_edge: number | null; growth_rate: number | null;
}
interface Bet { id: string; round_id: string; user_id: string; amount: string; multiplier: number; result: 'pending' | 'win' | 'loss'; payout: string }

const crashPoint = (r: Round) => Number(r.crash_point);
const growth = (r: Round) => r.growth_rate ?? DEFAULT_GROWTH;
const crashTime = (r: Round) => new Date(r.start_time.getTime() + (crashPoint(r) <= 1 ? 0 : (Math.log(crashPoint(r)) / Math.log(growth(r))) * 1000));
const currentMultiplier = (r: Round, now: Date) => growth(r) ** Math.max(0, (now.getTime() - r.start_time.getTime()) / 1000);
const plusSeconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000);
const nextRoundDue = (r: Round, s: Settings) => plusSeconds(crashTime(r), s.crash_display_seconds);

// Credits as the project's parse_amount: positive, at most two decimal places. Returns hundredths.
export function parseAmount(raw: unknown): bigint | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const text = String(raw).trim();
  const m = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return null;
  const value = BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
  return value > 0n && value <= MAX_AMOUNT ? value : null;
}
export const AMOUNT_ERROR = 'Enter a positive amount with no more than two decimal places';
export const credits = (hundredths: bigint | string | number) => Number(hundredths) / 100;
const creditText = (hundredths: bigint | string) => credits(hundredths).toFixed(2);

export async function getSettings(db: Db, lock = false): Promise<Settings> {
  return one<Settings>(db, `SELECT * FROM aviator_settings WHERE id = 1${lock ? ' FOR UPDATE' : ''}`);
}

export function settingsView(s: Settings) {
  return {
    betting_seconds: s.betting_seconds, crash_display_seconds: s.crash_display_seconds, growth_rate: s.growth_rate,
    house_edge_percent: Math.round(s.house_edge * 100 * 10_000) / 10_000,
    min_bet: credits(s.min_bet), max_bet: credits(s.max_bet), max_win: credits(s.max_win),
    paused: s.paused, pause_message: s.pause_message ?? '', updated_at: s.updated_at.toISOString(),
  };
}
const publicLimits = (s: Settings) => ({ min_bet: credits(s.min_bet), max_bet: credits(s.max_bet), max_win: credits(s.max_win) });

// Paused and the last round is over, so no new round may start.
const isParked = (r: Round | null, s: Settings, now: Date) => s.paused && (!r || (r.status === 'crashed' && now >= nextRoundDue(r, s)));

function needsTransition(r: Round | null, s: Settings, now: Date): boolean {
  if (isParked(r, s, now)) return false;
  if (!r) return true;
  if (r.status === 'crashed') return now >= nextRoundDue(r, s);
  if (r.status === 'waiting') return now >= r.start_time;
  return now >= crashTime(r);
}

async function settleLosses(db: Db, r: Round): Promise<void> {
  await db.query(`UPDATE aviator_bets SET result = 'loss', multiplier = $2, payout = 0 WHERE round_id = $1 AND result = 'pending'`, [r.id, crashPoint(r)]);
}

async function newRound(db: Db, now: Date, s: Settings): Promise<Round> {
  const seed = randomBytes(32).toString('hex');
  return one<Round>(db,
    `INSERT INTO aviator_rounds (crash_point, start_time, status, server_seed, hash, house_edge, growth_rate)
     VALUES ($1, $2, 'waiting', $3, $4, $5, $6) RETURNING *`,
    [generateCrashPoint(seed, s.house_edge), plusSeconds(now, s.betting_seconds), seed, seedHash(seed), s.house_edge, s.growth_rate]);
}

// Moves the latest round forward; the caller holds the game clock lock.
async function advanceRound(db: Db, now: Date, s: Settings): Promise<Round | null> {
  let r = await maybeOne<Round>(db, 'SELECT * FROM aviator_rounds ORDER BY id DESC LIMIT 1 FOR UPDATE');
  if (!s.paused && (!r || (r.status === 'crashed' && now >= nextRoundDue(r, s)))) r = await newRound(db, now, s);
  if (!r) return null;
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
  return { id: Number(bet.id), amount: credits(bet.amount), result: bet.result, multiplier: bet.multiplier, payout: credits(bet.payout) };
}

const commonState = (s: Settings, now: Date) => ({
  server_time: now.toISOString(), betting_seconds: s.betting_seconds, crash_display_seconds: s.crash_display_seconds, limits: publicLimits(s),
});

async function roundState(db: Db, r: Round, s: Settings, now: Date, userId: number) {
  const state: Record<string, unknown> = {
    ...commonState(s, now), round_id: Number(r.id), status: r.status, start_time: r.start_time.toISOString(), growth_rate: growth(r), hash: r.hash,
  };
  if (r.status === 'waiting') {
    state.starts_in = Math.max(0, Math.ceil((r.start_time.getTime() - now.getTime()) / 1000));
    state.multiplier = 1.0;
  } else if (r.status === 'active') {
    state.multiplier = Math.round(currentMultiplier(r, now) * 100) / 100;
  } else {
    state.multiplier = crashPoint(r);
    state.crash_point = crashPoint(r);
    state.server_seed = r.server_seed;
    state.next_round_in = Math.max(0, Math.ceil((nextRoundDue(r, s).getTime() - now.getTime()) / 1000));
  }
  const bet = await userBet(db, r, userId);
  if (bet) state.my_bet = bet;
  return state;
}

// GET state: a plain read first, so polling members do not block each other; a transition takes the clock lock.
export async function gameState(pool: { connect(): Promise<PoolClient> }, read: Db, userId: number, now: Date) {
  const s = await getSettings(read);
  let r = await maybeOne<Round>(read, 'SELECT * FROM aviator_rounds ORDER BY id DESC LIMIT 1');
  if (needsTransition(r, s, now)) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock($1)', [GAME_CLOCK_LOCK_KEY]);
      r = await advanceRound(db, now, s);
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    } finally {
      db.release();
    }
  }
  if (isParked(r, s, now)) {
    return { ...commonState(s, now), status: 'paused', round_id: r ? Number(r.id) : null, message: s.pause_message || 'The game is paused for maintenance. Please check back soon.' };
  }
  return roundState(read, r!, s, now, userId);
}

// Public fairness record; the seed is only revealed once the round is over.
function roundFairness(r: Round) {
  const over = r.status === 'crashed';
  return {
    round_id: Number(r.id), crash_point: over ? crashPoint(r) : null, hash: r.hash, server_seed: over ? r.server_seed : null,
    house_edge_percent: r.house_edge === null ? null : Math.round(r.house_edge * 100 * 10_000) / 10_000,
  };
}

export function verifyRound(r: Round) {
  const result: Record<string, unknown> = roundFairness(r);
  if (r.status !== 'crashed') return { ...result, verifiable: false, reason: 'The seed is revealed after the round ends.' };
  if (!r.server_seed || r.house_edge === null) return { ...result, verifiable: false, reason: 'This round was played before provably fair seeds were enabled.' };
  const computedHash = seedHash(r.server_seed);
  const computedCrash = generateCrashPoint(r.server_seed, r.house_edge);
  return {
    ...result, verifiable: true, computed_hash: computedHash, hash_matches: computedHash === r.hash,
    computed_crash_point: computedCrash, crash_matches: Math.abs(computedCrash - crashPoint(r)) < 1e-9, formula: FAIRNESS_FORMULA,
  };
}

export async function history(db: Db) {
  const list = await rows<Round>(db, `SELECT * FROM aviator_rounds WHERE status = 'crashed' ORDER BY id DESC LIMIT 10`);
  return list.map(roundFairness);
}

export async function verify(db: Db, roundId: number) {
  const r = await maybeOne<Round>(db, 'SELECT * FROM aviator_rounds WHERE id = $1', [roundId]);
  if (!r) throw notFound('aviator.no_round', 'Round not found');
  return verifyRound(r);
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
  const s = await getSettings(db);
  if (s.paused) throw conflict('aviator.paused', 'Betting is paused right now');
  if (amount < BigInt(s.min_bet)) throw badRequest('aviator.min_bet', `Minimum bet is ${creditText(s.min_bet)} credits`);
  if (amount > BigInt(s.max_bet)) throw badRequest('aviator.max_bet', `Maximum bet is ${creditText(s.max_bet)} credits`);
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
  let payout = BigInt(Math.round(Number(bet.amount) * multiplier)); // round half up to the hundredth, as the project
  const maxWin = BigInt((await getSettings(db)).max_win);
  const capped = payout > maxWin;
  if (capped) payout = maxWin;
  if (held + payout > MAX_AMOUNT) payout = MAX_AMOUNT - held; // the wallet's own ceiling
  await db.query(`UPDATE aviator_bets SET result = 'win', multiplier = $2, payout = $3 WHERE id = $1`, [bet.id, multiplier, payout.toString()]);
  await db.query('UPDATE aviator_wallets SET balance = balance + $2, updated_at = now() WHERE user_id = $1', [userId, payout.toString()]);
  return {
    crashed: false as const, message: capped ? 'Cashout successful (capped at the maximum win)' : 'Cashout successful', capped,
    payout: credits(payout), multiplier, balance: credits(held + payout),
  };
}

// Demo mode (wallet.py, 2026-11-06, later): credits are added or removed at once, no staff approval.
export async function moveCredits(db: Db, userId: number, kind: 'deposit' | 'withdrawal', rawAmount: unknown) {
  const amount = parseAmount(rawAmount);
  if (amount === null) throw badRequest('validation_failed', AMOUNT_ERROR, { amount: [AMOUNT_ERROR] });
  const before = await wallet(db, userId, true);
  const after = kind === 'deposit' ? before + amount : before - amount;
  if (after < 0n) throw badRequest('aviator.insufficient', 'Insufficient balance');
  if (after > MAX_AMOUNT) throw badRequest('aviator.too_much', 'The balance would exceed the maximum');
  await db.query('UPDATE aviator_wallets SET balance = $2, updated_at = now() WHERE user_id = $1', [userId, after.toString()]);
  await db.query(
    `INSERT INTO aviator_requests (user_id, kind, amount, status, balance_before, balance_after, decided_at) VALUES ($1, $2, $3, 'completed', $4, $5, now())`,
    [userId, kind, amount.toString(), before.toString(), after.toString()],
  );
  return { message: kind === 'deposit' ? 'Credits added to your wallet' : 'Credits removed from your wallet', balance: credits(after) };
}

export async function transactions(db: Db, userId: number) {
  const list = await rows<{ kind: string; amount: string; status: string; created_at: Date }>(
    db, 'SELECT kind, amount, status, created_at FROM aviator_requests WHERE user_id = $1 ORDER BY id DESC LIMIT 100', [userId],
  );
  return list.map(t => ({ type: t.kind, amount: credits(t.amount), status: t.status, date: t.created_at.toISOString() }));
}

// ----- Staff console (the project's admin dashboard, without its own users, logins and 2FA) -----

export async function listRequests(db: Db, limit = 200) {
  const list = await rows<{ public_id: string; user_public_id: string; username: string; kind: string; amount: string; status: string; created_at: Date; balance: string | null; reason: string | null }>(
    db,
    `SELECT r.public_id, u.public_id AS user_public_id, u.username, r.kind, r.amount, r.status, r.created_at, w.balance, r.reason
     FROM aviator_requests r JOIN users u ON u.id = r.user_id LEFT JOIN aviator_wallets w ON w.user_id = r.user_id
     ORDER BY (r.status = 'pending') DESC, r.id DESC LIMIT $1`, [limit],
  );
  return list.map(r => ({
    id: r.public_id, userId: r.user_public_id, username: r.username, kind: r.kind, amount: credits(r.amount), status: r.status,
    createdAt: r.created_at, balance: credits(r.balance ?? '0'), reason: r.reason ?? '',
  }));
}

// Older pending requests (from before credits applied at once) can still be approved or rejected.
export async function processRequest(db: Db, staffId: number, publicId: string, action: 'approve' | 'reject') {
  const r = await maybeOne<{ id: string; user_id: string; kind: string; amount: string; status: string }>(
    db, 'SELECT id, user_id, kind, amount, status FROM aviator_requests WHERE public_id = $1 FOR UPDATE', [publicId],
  );
  if (!r) throw notFound();
  if (r.status !== 'pending') throw conflict('aviator.processed', 'Request already processed');
  if (action === 'approve') {
    const held = await wallet(db, Number(r.user_id), true);
    if (r.kind === 'withdrawal' && held < BigInt(r.amount)) throw badRequest('aviator.insufficient', 'User has insufficient balance for approval');
    if (r.kind === 'deposit' && held + BigInt(r.amount) > MAX_AMOUNT) throw badRequest('aviator.too_much', 'The balance would exceed the maximum');
    await db.query(`UPDATE aviator_wallets SET balance = balance ${r.kind === 'deposit' ? '+' : '-'} $2, updated_at = now() WHERE user_id = $1`, [r.user_id, r.amount]);
  }
  await db.query('UPDATE aviator_requests SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1', [r.id, action === 'approve' ? 'approved' : 'rejected', staffId]);
  return { kind: r.kind, amount: credits(r.amount), status: action === 'approve' ? 'approved' : 'rejected' };
}

export interface SettingsInput {
  betting_seconds?: number; crash_display_seconds?: number; growth_rate?: number; house_edge_percent?: number;
  min_bet?: string | number; max_bet?: string | number; max_win?: string | number; paused?: boolean; pause_message?: string;
}

export async function updateSettings(db: Db, staffId: number, input: SettingsInput) {
  const s = await getSettings(db, true);
  const before = settingsView(s);
  const errors: string[] = [];
  const next = { ...s };
  const whole = (name: 'betting_seconds' | 'crash_display_seconds', low: number, high: number) => {
    const v = input[name];
    if (v === undefined) return;
    if (!Number.isInteger(v) || v < low || v > high) errors.push(`${name.replace(/_/g, ' ')} must be a whole number from ${low} to ${high}`);
    else next[name] = v;
  };
  whole('betting_seconds', 3, 60);
  whole('crash_display_seconds', 1, 30);
  if (input.growth_rate !== undefined) {
    if (!(input.growth_rate >= 1.01 && input.growth_rate <= 1.5)) errors.push('growth rate must be between 1.01 and 1.5');
    else next.growth_rate = input.growth_rate;
  }
  if (input.house_edge_percent !== undefined) {
    if (!(input.house_edge_percent >= 0 && input.house_edge_percent <= 20)) errors.push('house edge must be between 0 and 20 percent');
    else next.house_edge = Math.round((input.house_edge_percent / 100) * 1e6) / 1e6;
  }
  for (const name of ['min_bet', 'max_bet', 'max_win'] as const) {
    if (input[name] === undefined) continue;
    const v = parseAmount(input[name]);
    if (v === null) errors.push(`${name.replace(/_/g, ' ')}: ${AMOUNT_ERROR.toLowerCase()}`);
    else next[name] = v.toString();
  }
  if (input.paused !== undefined) next.paused = input.paused;
  if (input.pause_message !== undefined) next.pause_message = input.pause_message.trim() || null;
  if (!errors.length) {
    if (BigInt(next.min_bet) > BigInt(next.max_bet)) errors.push('minimum bet cannot be larger than the maximum bet');
    if (BigInt(next.max_win) < BigInt(next.max_bet)) errors.push('maximum win cannot be smaller than the maximum bet');
  }
  if (errors.length) throw badRequest('validation_failed', `Invalid settings: ${errors.join('; ')}`);
  const saved = await one<Settings>(db,
    `UPDATE aviator_settings SET betting_seconds = $1, crash_display_seconds = $2, growth_rate = $3, house_edge = $4, min_bet = $5,
       max_bet = $6, max_win = $7, paused = $8, pause_message = $9, updated_by = $10, updated_at = now() WHERE id = 1 RETURNING *`,
    [next.betting_seconds, next.crash_display_seconds, next.growth_rate, next.house_edge, next.min_bet, next.max_bet, next.max_win, next.paused, next.pause_message, staffId]);
  const after = settingsView(saved);
  const changed = (Object.keys(after) as (keyof typeof after)[]).filter(k => k !== 'updated_at' && before[k] !== after[k]);
  return { before, after, changed };
}

// Adjust a member's demo credits (add, subtract or set), with a reason kept with the record and in the audit log.
export async function adjustBalance(db: Db, staffId: number, userId: number, mode: 'add' | 'subtract' | 'set', rawAmount: unknown, reason: string) {
  let amount: bigint | null;
  if (mode === 'set' && ['0', '0.0', '0.00'].includes(String(rawAmount).trim())) amount = 0n;
  else amount = parseAmount(rawAmount);
  if (amount === null) throw badRequest('validation_failed', AMOUNT_ERROR, { amount: [AMOUNT_ERROR] });
  const why = reason.trim();
  if (why.length < 3 || why.length > 200) throw badRequest('validation_failed', 'Give a reason (3-200 characters); it is kept in the audit log', { reason: ['3 to 200 characters'] });
  const before = await wallet(db, userId, true);
  const after = mode === 'add' ? before + amount : mode === 'subtract' ? before - amount : amount;
  if (after < 0n) throw badRequest('aviator.below_zero', 'The balance cannot go below zero');
  if (after > MAX_AMOUNT) throw badRequest('aviator.too_much', 'The balance would exceed the maximum');
  await db.query('UPDATE aviator_wallets SET balance = $2, updated_at = now() WHERE user_id = $1', [userId, after.toString()]);
  const change = after - before;
  if (change !== 0n) {
    await db.query(
      `INSERT INTO aviator_requests (user_id, kind, amount, status, balance_before, balance_after, reason, decided_by, decided_at)
       VALUES ($1, 'adjustment', $2, 'completed', $3, $4, $5, $6, now())`,
      [userId, (change < 0n ? -change : change).toString(), before.toString(), after.toString(), why, staffId],
    );
  }
  return { mode, amount: credits(amount), before: credits(before), after: credits(after), reason: why };
}

const SETTLED = `result IN ('win', 'loss')`;
const num = (v: string | null | undefined) => Number(v ?? 0);

function totals(row: { bets: string; staked: string | null; paid: string | null; wins: string }) {
  const staked = credits(num(row.staked));
  const paid = credits(num(row.paid));
  return {
    bets: Number(row.bets), staked, paid, house_profit: Math.round((staked - paid) * 100) / 100, wins: Number(row.wins),
    rtp: staked ? Math.round((paid / staked) * 10_000) / 10_000 : null,
  };
}
const TOTALS_SQL = `count(*) AS bets, sum(amount) AS staked, sum(payout) AS paid, count(*) FILTER (WHERE result = 'win') AS wins`;

// Overview (the project's reports): staked, paid out, house profit, actual against target return, daily figures,
// biggest wins, top winners and losers, over 1 to 365 days.
export async function reports(db: Db, days: number) {
  const s = await getSettings(db);
  const since = `now() - make_interval(days => $1)`;
  const t = await one<{ bets: string; staked: string | null; paid: string | null; wins: string; players: string }>(db,
    `SELECT ${TOTALS_SQL}, count(DISTINCT user_id) AS players FROM aviator_bets WHERE ${SETTLED} AND created_at >= ${since}`, [days]);
  const extra = await one<{ rounds: string; deposits: string | null; withdrawals: string | null }>(db,
    `SELECT (SELECT count(*) FROM aviator_rounds WHERE status = 'crashed' AND start_time >= ${since}) AS rounds,
            (SELECT sum(amount) FROM aviator_requests WHERE kind = 'deposit' AND status IN ('completed', 'approved') AND created_at >= ${since}) AS deposits,
            (SELECT sum(amount) FROM aviator_requests WHERE kind = 'withdrawal' AND status IN ('completed', 'approved') AND created_at >= ${since}) AS withdrawals`, [days]);
  const daily = await rows<{ day: string; bets: string; staked: string | null; paid: string | null; wins: string; players: string }>(db,
    `SELECT to_char((created_at AT TIME ZONE 'Africa/Kampala')::date, 'YYYY-MM-DD') AS day, ${TOTALS_SQL}, count(DISTINCT user_id) AS players
     FROM aviator_bets WHERE ${SETTLED} AND created_at >= ${since} GROUP BY 1 ORDER BY 1 DESC`, [days]);
  const biggest = await rows<{ id: string; username: string; amount: string; multiplier: number; payout: string; created_at: Date }>(db,
    `SELECT b.id, u.username, b.amount, b.multiplier, b.payout, b.created_at FROM aviator_bets b JOIN users u ON u.id = b.user_id
     WHERE b.result = 'win' AND b.created_at >= ${since} ORDER BY b.payout - b.amount DESC LIMIT 10`, [days]);
  const players = (order: 'DESC' | 'ASC') => rows<{ public_id: string; username: string; bets: string; staked: string; paid: string }>(db,
    `SELECT u.public_id, u.username, count(*) AS bets, sum(b.amount) AS staked, sum(b.payout) AS paid
     FROM aviator_bets b JOIN users u ON u.id = b.user_id WHERE b.${SETTLED} AND b.created_at >= ${since}
     GROUP BY u.id ORDER BY sum(b.payout) - sum(b.amount) ${order} LIMIT 10`, [days]);
  const playerView = (p: { public_id: string; username: string; bets: string; staked: string; paid: string }) => ({
    userId: p.public_id, username: p.username, bets: Number(p.bets), staked: credits(p.staked), paid: credits(p.paid), net: credits(num(p.paid) - num(p.staked)),
  });
  return {
    days,
    totals: {
      ...totals(t), players: Number(t.players), rounds: Number(extra.rounds),
      deposits: credits(num(extra.deposits)), withdrawals: credits(num(extra.withdrawals)), target_rtp: Math.round((1 - s.house_edge) * 10_000) / 10_000,
    },
    daily: daily.map(d => ({ date: d.day, ...totals(d), players: Number(d.players) })),
    biggest_wins: biggest.map(b => ({
      bet_id: Number(b.id), username: b.username, amount: credits(b.amount), multiplier: Math.round(b.multiplier * 100) / 100,
      payout: credits(b.payout), profit: credits(num(b.payout) - num(b.amount)), date: b.created_at.toISOString(),
    })),
    top_winners: (await players('DESC')).map(playerView),
    top_losers: (await players('ASC')).map(playerView),
  };
}

async function roundStats(db: Db, ids: string[]) {
  if (!ids.length) return new Map<string, { bets: number; staked: number; paid: number; wins: number }>();
  const list = await rows<{ round_id: string; bets: string; staked: string; paid: string; wins: string }>(db,
    `SELECT round_id, ${TOTALS_SQL} FROM aviator_bets WHERE round_id = ANY($1::bigint[]) GROUP BY round_id`, [ids]);
  return new Map(list.map(r => [r.round_id, { bets: Number(r.bets), staked: credits(r.staked), paid: credits(r.paid), wins: Number(r.wins) }]));
}

function roundSummary(r: Round, stats: Map<string, { bets: number; staked: number; paid: number; wins: number }>) {
  const st = stats.get(r.id) ?? { bets: 0, staked: 0, paid: 0, wins: 0 };
  const over = r.status === 'crashed';
  return {
    id: Number(r.id), status: r.status, start_time: r.start_time.toISOString(),
    crash_point: over ? crashPoint(r) : null, // never the crash point of a round still running
    ...st, house_profit: over ? Math.round((st.staked - st.paid) * 100) / 100 : null,
    provably_fair: Boolean(r.server_seed), house_edge_percent: r.house_edge === null ? null : Math.round(r.house_edge * 100 * 10_000) / 10_000,
  };
}

export async function listRounds(db: Db, limit: number) {
  const list = await rows<Round>(db, 'SELECT * FROM aviator_rounds ORDER BY id DESC LIMIT $1', [limit]);
  const stats = await roundStats(db, list.map(r => r.id));
  return list.map(r => roundSummary(r, stats));
}

async function roundBets(db: Db, roundId: string) {
  const list = await rows<{ id: string; public_id: string; username: string; amount: string; result: string; multiplier: number; payout: string }>(db,
    `SELECT b.id, u.public_id, u.username, b.amount, b.result, b.multiplier, b.payout FROM aviator_bets b JOIN users u ON u.id = b.user_id
     WHERE b.round_id = $1 ORDER BY b.amount DESC`, [roundId]);
  return list.map(b => ({
    bet_id: Number(b.id), userId: b.public_id, username: b.username, amount: credits(b.amount), result: b.result,
    multiplier: b.result === 'win' ? Math.round(b.multiplier * 100) / 100 : null, payout: credits(b.payout),
  }));
}

export async function roundDetail(db: Db, roundId: number) {
  const r = await maybeOne<Round>(db, 'SELECT * FROM aviator_rounds WHERE id = $1', [roundId]);
  if (!r) throw notFound('aviator.no_round', 'Round not found');
  return { round: roundSummary(r, await roundStats(db, [r.id])), fairness: verifyRound(r), bets: await roundBets(db, r.id) };
}

export async function live(db: Db, now: Date) {
  const s = await getSettings(db);
  const r = await maybeOne<Round>(db, 'SELECT * FROM aviator_rounds ORDER BY id DESC LIMIT 1');
  if (!r) return { round: null, paused: s.paused, bets: [], players_in_flight: 0 };
  const summary: Record<string, unknown> = roundSummary(r, await roundStats(db, [r.id]));
  if (r.status === 'active' && now < crashTime(r)) summary.multiplier = Math.round(currentMultiplier(r, now) * 100) / 100;
  else if (r.status === 'waiting') summary.starts_in = Math.max(0, Math.ceil((r.start_time.getTime() - now.getTime()) / 1000));
  const bets = await roundBets(db, r.id);
  return { round: summary, paused: s.paused, bets, players_in_flight: bets.filter(b => b.result === 'pending').length };
}

// Players: members who have an Aviator wallet or bets, with search by username.
export async function listPlayers(db: Db, q: string) {
  const list = await rows<{ public_id: string; username: string; status: string; balance: string; bets: string; staked: string | null; paid: string | null; last_bet: Date | null }>(db,
    `SELECT u.public_id, u.username, u.status, w.balance,
            (SELECT count(*) FROM aviator_bets b WHERE b.user_id = u.id) AS bets,
            (SELECT sum(amount) FROM aviator_bets b WHERE b.user_id = u.id AND b.${SETTLED}) AS staked,
            (SELECT sum(payout) FROM aviator_bets b WHERE b.user_id = u.id AND b.${SETTLED}) AS paid,
            (SELECT max(created_at) FROM aviator_bets b WHERE b.user_id = u.id) AS last_bet
     FROM aviator_wallets w JOIN users u ON u.id = w.user_id
     WHERE $1 = '' OR u.username ILIKE '%' || $1 || '%'
     ORDER BY last_bet DESC NULLS LAST, u.username LIMIT 200`, [q.replace(/[%_\\]/g, m => `\\${m}`)]);
  return list.map(p => ({
    userId: p.public_id, username: p.username, status: p.status, balance: credits(p.balance), bets: Number(p.bets),
    staked: credits(num(p.staked)), paid: credits(num(p.paid)), net: credits(num(p.paid) - num(p.staked)), lastBet: p.last_bet,
  }));
}

export async function playerDetail(db: Db, userId: number) {
  const u = await one<{ public_id: string; username: string; status: string; created_at: Date }>(db, 'SELECT public_id, username, status, created_at FROM users WHERE id = $1', [userId]);
  const bal = await maybeOne<{ balance: string }>(db, 'SELECT balance FROM aviator_wallets WHERE user_id = $1', [userId]);
  const t = await one<{ bets: string; staked: string | null; paid: string | null; wins: string; best: number | null }>(db,
    `SELECT ${TOTALS_SQL}, max(multiplier) FILTER (WHERE result = 'win') AS best FROM aviator_bets WHERE user_id = $1 AND ${SETTLED}`, [userId]);
  const bets = await rows<{ id: string; round_id: string; amount: string; result: string; multiplier: number; payout: string; created_at: Date }>(db,
    'SELECT id, round_id, amount, result, multiplier, payout, created_at FROM aviator_bets WHERE user_id = $1 ORDER BY id DESC LIMIT 50', [userId]);
  const moves = await rows<{ kind: string; amount: string; status: string; balance_before: string | null; balance_after: string | null; reason: string | null; created_at: Date; staff: string | null }>(db,
    `SELECT r.kind, r.amount, r.status, r.balance_before, r.balance_after, r.reason, r.created_at, s.username AS staff
     FROM aviator_requests r LEFT JOIN users s ON s.id = r.decided_by WHERE r.user_id = $1 ORDER BY r.id DESC LIMIT 50`, [userId]);
  const stats = totals(t);
  return {
    user: { id: u.public_id, username: u.username, status: u.status, createdAt: u.created_at, balance: credits(bal?.balance ?? '0') },
    stats: { ...stats, net: Math.round((stats.paid - stats.staked) * 100) / 100, best_multiplier: t.best === null ? null : Math.round(t.best * 100) / 100 },
    bets: bets.map(b => ({
      id: Number(b.id), round_id: Number(b.round_id), amount: credits(b.amount), result: b.result,
      multiplier: Math.round((b.multiplier || 0) * 100) / 100, payout: credits(b.payout), date: b.created_at.toISOString(),
    })),
    transactions: moves.map(m => ({
      type: m.kind, amount: credits(m.amount), status: m.status, reason: m.reason ?? '', staff: m.staff ?? '',
      before: m.balance_before === null ? null : credits(m.balance_before), after: m.balance_after === null ? null : credits(m.balance_after),
      date: m.created_at.toISOString(),
    })),
  };
}

// Review flags: unusually high returns (at least 20 settled bets and 1.5x or more paid out). A hint, not proof.
export const FLAG_MIN_BETS = 20;
export const FLAG_RTP = 1.5;
export async function flags(db: Db) {
  const list = await rows<{ public_id: string; username: string; bets: string; staked: string; paid: string }>(db,
    `SELECT u.public_id, u.username, count(*) AS bets, sum(b.amount) AS staked, sum(b.payout) AS paid
     FROM aviator_bets b JOIN users u ON u.id = b.user_id WHERE b.${SETTLED}
     GROUP BY u.id HAVING count(*) >= $1 AND sum(b.payout) >= $2 * sum(b.amount) ORDER BY sum(b.payout)::float / sum(b.amount) DESC LIMIT 100`,
    [FLAG_MIN_BETS, FLAG_RTP]);
  return {
    rules: { high_rtp: `At least ${FLAG_MIN_BETS} settled bets and paid out ${FLAG_RTP.toFixed(1)}x or more of what they staked.` },
    high_rtp: list.map(p => ({ userId: p.public_id, username: p.username, bets: Number(p.bets), staked: credits(p.staked), paid: credits(p.paid), rtp: Math.round((num(p.paid) / num(p.staked)) * 100) / 100 })),
  };
}

export async function auditTrail(db: Db) {
  const list = await rows<{ created_at: Date; staff: string | null; action: string; target_type: string | null; target_id: string | null; after: unknown; reason: string | null; ip: string | null }>(db,
    `SELECT a.created_at, s.username AS staff, a.action, a.target_type, a.target_id, a.after, a.reason, host(a.ip) AS ip
     FROM audit_log a LEFT JOIN users s ON s.id = a.actor_user_id WHERE a.action LIKE 'aviator.%' ORDER BY a.id DESC LIMIT 200`);
  return list.map(a => ({ date: a.created_at, staff: a.staff ?? '', action: a.action, target: a.target_id ?? '', details: a.after, reason: a.reason ?? '', ip: a.ip ?? '' }));
}

// CSV exports (bets, rounds, transactions). Cells that a spreadsheet would read as a formula are prefixed.
const EXPORT_LIMIT = 50_000;
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let text: string;
  if (v instanceof Date) text = v.toISOString();
  else if (typeof v === 'string') text = v;
  else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') text = v.toString();
  else text = JSON.stringify(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
export async function exportCsv(db: Db, kind: string): Promise<{ csv: string; rows: number } | null> {
  let header: string[];
  let data: unknown[][];
  if (kind === 'bets') {
    header = ['bet_id', 'round_id', 'username', 'amount', 'result', 'multiplier', 'payout', 'created_at'];
    data = (await rows<{ id: string; round_id: string; username: string; amount: string; result: string; multiplier: number; payout: string; created_at: Date }>(db,
      `SELECT b.id, b.round_id, u.username, b.amount, b.result, b.multiplier, b.payout, b.created_at FROM aviator_bets b JOIN users u ON u.id = b.user_id ORDER BY b.id DESC LIMIT $1`, [EXPORT_LIMIT]))
      .map(b => [b.id, b.round_id, b.username, creditText(b.amount), b.result, Math.round((b.multiplier || 0) * 10_000) / 10_000, creditText(b.payout), b.created_at]);
  } else if (kind === 'rounds') {
    header = ['round_id', 'status', 'start_time', 'crash_point', 'bets', 'staked', 'paid', 'house_profit', 'house_edge_percent', 'hash', 'server_seed'];
    const list = await rows<Round>(db, 'SELECT * FROM aviator_rounds ORDER BY id DESC LIMIT $1', [EXPORT_LIMIT]);
    const stats = await roundStats(db, list.map(r => r.id));
    data = list.map(r => {
      const s = roundSummary(r, stats);
      return [r.id, r.status, r.start_time, s.crash_point, s.bets, s.staked, s.paid, s.house_profit, s.house_edge_percent, r.hash, r.status === 'crashed' ? r.server_seed : null];
    });
  } else if (kind === 'transactions') {
    header = ['type', 'username', 'amount', 'status', 'balance_before', 'balance_after', 'reason', 'created_at'];
    data = (await rows<{ kind: string; username: string; amount: string; status: string; balance_before: string | null; balance_after: string | null; reason: string | null; created_at: Date }>(db,
      `SELECT r.kind, u.username, r.amount, r.status, r.balance_before, r.balance_after, r.reason, r.created_at FROM aviator_requests r JOIN users u ON u.id = r.user_id ORDER BY r.id DESC LIMIT $1`, [EXPORT_LIMIT]))
      .map(t => [t.kind, t.username, creditText(t.amount), t.status, t.balance_before && creditText(t.balance_before), t.balance_after && creditText(t.balance_after), t.reason, t.created_at]);
  } else {
    return null;
  }
  return { csv: [header, ...data].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n', rows: data.length };
}
