import { randomInt } from 'node:crypto';
import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';

// Aviator (owner, 2026-11-06): a crash game played with free game points, not money (TODO(owner): the money rules).
// The multiplier starts at 1.00x and grows with time; the plane flies away at a crash point the server picks before
// the round starts and never sends to the browser while the round runs. Cashing out before the crash pays
// stake x multiplier in points, worked out from the server's clock. The crash point gives a 3% house edge: the
// chance of reaching m is 0.97 / m.

export const AVIATOR = {
  dailyPoints: 1000, // a member below this is topped back up to it once per day
  minStake: 10,
  maxStake: 1000,
  growthPerSecond: 0.07, // multiplier = e^(0.07 t): 2x at about 10 s, 10x at about 33 s
  maxX100: 10_000, // 100.00x
  houseEdge: 0.03,
} as const;

// Picks the crash point, in hundredths (100 = 1.00x).
export function drawCrash(random = () => randomInt(0, 2 ** 32) / 2 ** 32): number {
  const x = (1 - AVIATOR.houseEdge) / (1 - random());
  return Math.min(AVIATOR.maxX100, Math.max(100, Math.floor(x * 100)));
}

export const multiplierAt = (elapsedMs: number): number => Math.floor(100 * Math.exp(AVIATOR.growthPerSecond * Math.max(0, elapsedMs) / 1000));
export const crashAfterMs = (crashX100: number): number => (Math.log(crashX100 / 100) / AVIATOR.growthPerSecond) * 1000;

interface RoundRow {
  id: string; public_id: string; user_id: string; stake: string; crash_x100: number; started_at: Date; status: string;
  cashout_x100: number | null; payout: string; ended_at: Date | null;
}

const eatToday = "(now() AT TIME ZONE 'Africa/Kampala')::date";

// The member's points, created or topped up for the day. Locks the row when `lock` is set.
async function wallet(db: Db, userId: number): Promise<bigint> {
  await db.query(
    `INSERT INTO aviator_wallets (user_id, points, refilled_on) VALUES ($1, $2, ${eatToday}) ON CONFLICT (user_id) DO NOTHING`,
    [userId, AVIATOR.dailyPoints],
  );
  const w = await one<{ points: string }>(
    db,
    `UPDATE aviator_wallets SET points = CASE WHEN refilled_on < ${eatToday} THEN greatest(points, $2) ELSE points END,
       refilled_on = ${eatToday}, updated_at = now() WHERE user_id = $1 RETURNING points`,
    [userId, AVIATOR.dailyPoints],
  );
  return BigInt(w.points);
}

// Ends a flying round whose crash time has passed.
async function settleIfCrashed(db: Db, r: RoundRow, now: Date): Promise<RoundRow> {
  if (r.status !== 'flying') return r;
  if (now.getTime() - r.started_at.getTime() < crashAfterMs(r.crash_x100)) return r;
  return one<RoundRow>(db, `UPDATE aviator_rounds SET status = 'crashed', ended_at = now() WHERE id = $1 RETURNING *`, [r.id]);
}

const roundView = (r: RoundRow, now: Date) => ({
  id: r.public_id,
  stake: r.stake,
  status: r.status,
  startedAt: r.started_at,
  elapsedMs: r.status === 'flying' ? now.getTime() - r.started_at.getTime() : null,
  // The crash point only once the round is over.
  crashX100: r.status === 'flying' ? null : r.crash_x100,
  cashoutX100: r.cashout_x100,
  payout: r.payout,
});

async function now(db: Db): Promise<Date> {
  return (await one<{ now: Date }>(db, 'SELECT clock_timestamp() AS now')).now;
}

export async function aviatorState(db: Db, userId: number) {
  const points = await wallet(db, userId);
  const t = await now(db);
  const flying = await maybeOne<RoundRow>(db, `SELECT * FROM aviator_rounds WHERE user_id = $1 AND status = 'flying' FOR UPDATE`, [userId]);
  const current = flying ? await settleIfCrashed(db, flying, t) : null;
  const history = await rows<RoundRow>(db, `SELECT * FROM aviator_rounds WHERE user_id = $1 AND status <> 'flying' ORDER BY id DESC LIMIT 15`, [userId]);
  return {
    points: points.toString(), rules: { minStake: AVIATOR.minStake, maxStake: AVIATOR.maxStake, dailyPoints: AVIATOR.dailyPoints, growthPerSecond: AVIATOR.growthPerSecond },
    current: current && current.status === 'flying' ? roundView(current, t) : null,
    history: history.map(r => roundView(r, t)),
  };
}

export async function startRound(db: Db, userId: number, stake: number) {
  if (!Number.isInteger(stake) || stake < AVIATOR.minStake || stake > AVIATOR.maxStake) {
    throw badRequest('validation_failed', `Stake ${AVIATOR.minStake} to ${AVIATOR.maxStake} points.`, { stake: [`Stake ${AVIATOR.minStake} to ${AVIATOR.maxStake} points.`] });
  }
  await wallet(db, userId);
  const { points } = await one<{ points: string }>(db, 'SELECT points FROM aviator_wallets WHERE user_id = $1 FOR UPDATE', [userId]);
  const t = await now(db);
  const flying = await maybeOne<RoundRow>(db, `SELECT * FROM aviator_rounds WHERE user_id = $1 AND status = 'flying' FOR UPDATE`, [userId]);
  if (flying && (await settleIfCrashed(db, flying, t)).status === 'flying') throw conflict('aviator.flying', 'Your plane is still flying. Cash out or wait for it to fly away.');
  if (BigInt(points) < BigInt(stake)) throw badRequest('aviator.points', 'Not enough points for that stake. Your points are topped up every day.');
  await db.query('UPDATE aviator_wallets SET points = points - $2, updated_at = now() WHERE user_id = $1', [userId, stake]);
  const r = await one<RoundRow>(
    db, 'INSERT INTO aviator_rounds (user_id, stake, crash_x100, started_at) VALUES ($1, $2, $3, $4) RETURNING *', [userId, stake, drawCrash(), t],
  );
  return { round: roundView(r, t), points: (BigInt(points) - BigInt(stake)).toString() };
}

export async function roundStatus(db: Db, userId: number, publicId: string) {
  const r = await maybeOne<RoundRow>(db, 'SELECT * FROM aviator_rounds WHERE public_id = $1 AND user_id = $2 FOR UPDATE', [publicId, userId]);
  if (!r) throw notFound();
  const t = await now(db);
  return { round: roundView(await settleIfCrashed(db, r, t), t) };
}

export async function cashOut(db: Db, userId: number, publicId: string) {
  const r = await maybeOne<RoundRow>(db, 'SELECT * FROM aviator_rounds WHERE public_id = $1 AND user_id = $2 FOR UPDATE', [publicId, userId]);
  if (!r) throw notFound();
  const t = await now(db);
  const settled = await settleIfCrashed(db, r, t);
  if (settled.status !== 'flying') {
    const points = await wallet(db, userId);
    return { round: roundView(settled, t), points: points.toString() };
  }
  const x100 = Math.min(multiplierAt(t.getTime() - r.started_at.getTime()), r.crash_x100 - 1);
  const payout = (BigInt(r.stake) * BigInt(Math.max(100, x100))) / 100n;
  const done = await one<RoundRow>(
    db, `UPDATE aviator_rounds SET status = 'cashed', cashout_x100 = $2, payout = $3, ended_at = now() WHERE id = $1 RETURNING *`,
    [r.id, Math.max(100, x100), payout.toString()],
  );
  const w = await one<{ points: string }>(db, 'UPDATE aviator_wallets SET points = points + $2, updated_at = now() WHERE user_id = $1 RETURNING points', [userId, payout.toString()]);
  return { round: roundView(done, t), points: w.points };
}
