import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateCrashPoint, parseAmount, seedHash } from '../../src/modules/aviator/service.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import type { TestClient } from '../helpers/client.js';
import { createStaff, loginStaff, registerMember, type Member } from '../helpers/factories.js';

// Betting tips and Aviator (owner, 2026-11-06; Aviator updated from the owner's project 2026-11-06, later).
let app: TestApp;
let admin: TestClient;
let support: TestClient;

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call */
type Body = Record<string, any> & { error?: { code: string; fields?: Record<string, string[]> } };
const key = () => ({ 'idempotency-key': randomUUID() });

beforeAll(async () => {
  app = await startTestApp({ TEST_AUTO_APPROVE: 'true' });
  admin = await loginStaff(app, await createStaff(app, ['admin']));
  support = await loginStaff(app, await createStaff(app, ['support']));
});
afterAll(async () => {
  await app.close();
});

async function activated(): Promise<Member> {
  const m = await registerMember(app, {});
  const info = await m.client.get<Body>('/api/payments/channels');
  const res = await m.client.post<Body>('/api/payments/deposits', { channel: info.body.channels[0].code, senderPhone: m.input.phone, providerTxnId: `TEST${randomUUID().slice(0, 8)}` }, key());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return m;
}

describe('betting tips', () => {
  it('lets admins post and settle tips that activated members read', async () => {
    const member = await activated();
    const tip = { league: 'Premier League', homeTeam: 'Home FC', awayTeam: 'Away FC', kickoffAt: new Date(Date.now() + 86_400_000).toISOString(), tip: 'Home win', odds: '1.85' };
    expect((await support.post<Body>('/api/admin/tips', tip)).status).toBe(403);
    expect((await admin.post<Body>('/api/admin/tips', { ...tip, odds: 'abc' })).body.error?.fields?.odds).toBeDefined();
    const created = await admin.post<Body>('/api/admin/tips', tip);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.tip.id as string;
    expect((await member.client.get<Body>('/api/tips')).body.tips.find((t: Body) => t.id === id)).toMatchObject({ homeTeam: 'Home FC', tip: 'Home win', odds: '1.85', result: 'pending' });
    expect((await admin.put<Body>(`/api/admin/tips/${id}`, { ...tip, result: 'won', score: '2-1' })).body.tip).toMatchObject({ result: 'won', score: '2-1' });
    await admin.post<Body>(`/api/admin/tips/${id}/remove`, {});
    expect((await member.client.get<Body>('/api/tips')).body.tips.some((t: Body) => t.id === id)).toBe(false);
  });
});

describe("aviator (the owner's project, demo credits)", () => {
  it('draws provably fair crash points and reads amounts as the project does', () => {
    // Reference values from the project's generate_crash_point (Python) for the same seeds.
    expect([generateCrashPoint('a'.repeat(64), 0.01), generateCrashPoint('0'.repeat(64), 0.01), generateCrashPoint('deadbeef'.repeat(8), 0.05)]).toEqual([8.14, 2.74, 5.04]);
    expect([generateCrashPoint('seed-1', 0.01), generateCrashPoint('seed-2', 0.05), generateCrashPoint('seed-3', 0.01)]).toEqual([7, 1.11, 10.55]);
    expect(seedHash('seed-1').slice(0, 16)).toBe('0eb026731d9ea3f8');
    expect([parseAmount('10'), parseAmount('10.5'), parseAmount('0.01'), parseAmount('1.234'), parseAmount('0'), parseAmount(true)]).toEqual([1000n, 1050n, 1n, null, null, null]);
  });

  it('runs shared rounds with instant credits, fair seeds, a pause switch, limits and the staff dashboard', async () => {
    const m = await activated();
    // A test clock from the real time (sessions check the clock too).
    const base = Date.now();
    let clock = new Date(base);
    app.services.now = () => clock;
    const at = (seconds: number) => { clock = new Date(base + seconds * 1000); };
    const poll = async () => (await m.client.get<Body>('/api/aviator/game/state')).body;

    // Demo credits apply at once (the project, 2026-11-06, later).
    const added = await m.client.post<Body>('/api/aviator/wallet/deposit', { amount: '100' });
    expect([added.status, added.body.balance]).toEqual([201, 100]);
    expect((await m.client.post<Body>('/api/aviator/wallet/withdraw', { amount: '500' })).status).toBe(400);
    expect((await m.client.get<Body>('/api/aviator/wallet/transactions')).body[0]).toMatchObject({ type: 'deposit', amount: 100, status: 'completed' });

    // Round 1: the seed's hash is shown while members bet, the seed only after the crash.
    const state = await poll();
    expect(state).toMatchObject({ status: 'waiting', betting_seconds: 8, limits: { min_bet: 0.01, max_bet: 10000, max_win: 1000000 } });
    expect(state.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(state.server_seed).toBeUndefined();
    expect((await m.client.get<Body>(`/api/aviator/game/verify/${state.round_id}`)).body).toMatchObject({ verifiable: false, crash_point: null, server_seed: null });
    await app.owner.query('UPDATE aviator_rounds SET crash_point = 5 WHERE id = $1', [state.round_id]);
    // The Aviator terms come first (owner, 2026-11-19).
    expect((await m.client.post<Body>('/api/aviator/game/bet', { amount: '10' })).body.error?.code).toBe('aviator.terms_required');
    const terms = (await m.client.get<Body>('/api/aviator/terms')).body;
    expect(terms).toMatchObject({ accepted: false });
    expect((await m.client.post<Body>('/api/aviator/terms/accept', { version: '2000-01-01' })).body.error?.code).toBe('aviator.terms_changed');
    expect((await m.client.post<Body>('/api/aviator/terms/accept', { version: terms.version })).body).toMatchObject({ accepted: true });
    expect((await m.client.get<Body>('/api/aviator/terms')).body.accepted).toBe(true);
    const bet = await m.client.post<Body>('/api/aviator/game/bet', { amount: '10' });
    expect(bet.status, JSON.stringify(bet.body)).toBe(200);
    expect(bet.body.balance).toBe(90);
    expect((await m.client.post<Body>('/api/aviator/game/bet', { amount: '10' })).status).toBe(409);
    expect((await m.client.post<Body>('/api/aviator/game/bet', { amount: '1.234' })).status).toBe(400);

    at(9); // one second after take-off: 1.1x
    expect((await poll()).status).toBe('active');
    const cash = await m.client.post<Body>('/api/aviator/game/cashout', { bet_id: bet.body.bet_id });
    expect(cash.status, JSON.stringify(cash.body)).toBe(200);
    expect(cash.body.multiplier).toBeCloseTo(1.1);
    expect([cash.body.payout, cash.body.balance, cash.body.capped]).toEqual([11, 101, false]);

    // The crash reveals the seed. This round's crash point was changed by hand, so it does not verify.
    const crashAt = 8 + Math.log(5) / Math.log(1.1);
    at(crashAt + 0.5);
    const crashed = await poll();
    expect(crashed).toMatchObject({ status: 'crashed', crash_point: 5 });
    expect(seedHash(crashed.server_seed)).toBe(state.hash);
    expect((await m.client.get<Body>(`/api/aviator/game/verify/${state.round_id}`)).body).toMatchObject({ verifiable: true, hash_matches: true, crash_matches: false });

    // Round 2: the plane flies away at 1.5x and the bet is lost.
    const t0 = crashAt + 3.5;
    at(t0);
    const next = await poll();
    expect(next.status).toBe('waiting');
    expect(next.round_id).not.toBe(state.round_id);
    const lost = await m.client.post<Body>('/api/aviator/game/bet', { amount: '20' });
    await app.owner.query('UPDATE aviator_rounds SET crash_point = 1.5 WHERE id = $1', [next.round_id]);
    at(t0 + 8 + 2); // in flight at 1.21x
    expect((await poll()).status).toBe('active');
    at(t0 + 8 + 10); // past the 1.5x crash
    expect((await m.client.post<Body>('/api/aviator/game/cashout', { bet_id: lost.body.bet_id })).body.status).toBe('crashed');
    expect((await m.client.get<Body>('/api/aviator/wallet/balance')).body.balance).toBe(81);
    expect((await m.client.get<Body>('/api/aviator/game/history')).body.map((r: Body) => r.crash_point)).toContain(1.5);

    // Admin pause: once the round is over no new one starts, and bets are refused.
    expect((await support.put<Body>('/api/admin/aviator/settings', { paused: true })).status).toBe(403);
    expect((await admin.put<Body>('/api/admin/aviator/settings', { min_bet: '50', max_bet: '10' })).status).toBe(400);
    const paused = await admin.put<Body>('/api/admin/aviator/settings', { paused: true, pause_message: 'Back soon' });
    expect(paused.body.settings).toMatchObject({ paused: true, pause_message: 'Back soon' });
    at(t0 + 28);
    expect(await poll()).toMatchObject({ status: 'paused', message: 'Back soon' });
    expect((await m.client.post<Body>('/api/aviator/game/bet', { amount: '1' })).status).toBe(409);

    // Round 3: bet limits and the maximum win per bet.
    await admin.put<Body>('/api/admin/aviator/settings', { paused: false, max_bet: '20', max_win: '20' });
    const fresh = await poll();
    expect(fresh).toMatchObject({ status: 'waiting', limits: { max_bet: 20, max_win: 20 } });
    expect((await m.client.post<Body>('/api/aviator/game/bet', { amount: '21' })).status).toBe(400);
    await app.owner.query('UPDATE aviator_rounds SET crash_point = 50 WHERE id = $1', [fresh.round_id]);
    const big = await m.client.post<Body>('/api/aviator/game/bet', { amount: '20' });
    at(t0 + 28 + 8 + 10); // 2.59x
    expect((await poll()).status).toBe('active');
    const capped = await m.client.post<Body>('/api/aviator/game/cashout', { bet_id: big.body.bet_id });
    expect([capped.body.payout, capped.body.capped, capped.body.balance]).toEqual([20, true, 81]);
    await admin.put<Body>('/api/admin/aviator/settings', { max_bet: '10000', max_win: '1000000' });

    // Staff console: balance changes need a reason and are audited; reports, rounds, players and exports.
    const player = (await admin.get<Body>(`/api/admin/aviator/players?q=${m.input.username}`)).body.players[0];
    expect(player).toMatchObject({ username: m.input.username, balance: 81, bets: 3 });
    expect((await admin.post<Body>(`/api/admin/aviator/players/${player.userId}/balance`, { mode: 'add', amount: '10', reason: '' })).status).toBe(400);
    expect((await admin.post<Body>(`/api/admin/aviator/players/${player.userId}/balance`, { mode: 'subtract', amount: '500', reason: 'test' })).status).toBe(400);
    expect((await support.post<Body>(`/api/admin/aviator/players/${player.userId}/balance`, { mode: 'set', amount: '0', reason: 'test' })).status).toBe(403);
    const set = await admin.post<Body>(`/api/admin/aviator/players/${player.userId}/balance`, { mode: 'set', amount: '0', reason: 'Reset for testing' });
    expect(set.body.balance).toBe(0);
    const detail = (await admin.get<Body>(`/api/admin/aviator/players/${player.userId}`)).body;
    expect(detail.transactions[0]).toMatchObject({ type: 'adjustment', amount: 81, before: 81, after: 0, reason: 'Reset for testing' });
    expect(detail.stats).toMatchObject({ bets: 3, wins: 2 });
    const report = (await support.get<Body>('/api/admin/aviator/reports?days=7')).body;
    expect(report.totals).toMatchObject({ bets: 3, staked: 50, paid: 31, house_profit: 19, target_rtp: 0.99 });
    const rounds = (await admin.get<Body>('/api/admin/aviator/rounds')).body.rounds as Body[];
    expect(rounds.filter(r => r.status !== 'crashed').every(r => r.crash_point === null)).toBe(true);
    expect((await admin.get<Body>(`/api/admin/aviator/rounds/${state.round_id}`)).body.bets[0]).toMatchObject({ username: m.input.username, result: 'win' });
    expect((await admin.get<Body>('/api/admin/aviator/live')).body.round).toBeTruthy();
    expect((await admin.get<Body>('/api/admin/aviator/flags')).body.high_rtp).toEqual([]);
    const csv = await admin.get<string>('/api/admin/aviator/export/bets.csv');
    expect(csv.status).toBe(200);
    expect(String(csv.body).split('\r\n')[0]).toBe('bet_id,round_id,username,amount,result,multiplier,payout,created_at');
    expect((await support.get<Body>('/api/admin/aviator/export/bets.csv')).status).toBe(403);
    expect((await admin.get<Body>('/api/admin/aviator/audit')).body.entries.map((a: Body) => a.action))
      .toEqual(expect.arrayContaining(['aviator.balance_adjust', 'aviator.settings_update', 'aviator.export']));

    // Older pending requests (from before credits applied at once) can still be processed.
    await app.owner.query(`INSERT INTO aviator_requests (user_id, kind, amount) SELECT id, 'deposit', 500 FROM users WHERE username = $1`, [m.input.username]);
    const pending = (await admin.get<Body>('/api/admin/aviator/transactions')).body.requests.find((r: Body) => r.status === 'pending');
    expect((await support.post<Body>(`/api/admin/aviator/requests/${pending.id}/process`, { action: 'approve' })).status).toBe(403);
    expect((await admin.post<Body>(`/api/admin/aviator/requests/${pending.id}/process`, { action: 'approve' })).status).toBe(200);
    expect((await m.client.get<Body>('/api/aviator/wallet/balance')).body.balance).toBe(5);

    // Demo credits are not money: no ledger rows.
    expect((await app.owner.query(`SELECT 1 FROM ledger_transactions WHERE ref_type = 'aviator'`)).rowCount).toBe(0);
    app.services.now = () => new Date();
  });

  it('ends a round at the house limit so the house money never goes below the floor (owner, 2026-11-16)', async () => {
    // Start from a finished round, on a test clock past every earlier round.
    await app.owner.query(`UPDATE aviator_rounds SET status = 'crashed' WHERE status <> 'crashed'`);
    const last = (await app.owner.query<{ t: Date }>('SELECT max(start_time) AS t FROM aviator_rounds')).rows[0]!.t;
    let clock = new Date(Math.max(Date.now(), last.getTime()) + 120_000);
    app.services.now = () => clock;
    const [a, b] = [await activated(), await activated()];
    const { version } = (await a.client.get<Body>('/api/aviator/terms')).body;
    for (const m of [a, b]) {
      await m.client.post<Body>('/api/aviator/wallet/deposit', { amount: '100' });
      await m.client.post<Body>('/api/aviator/terms/accept', { version });
    }

    // House money 100, floor 50: players can win at most 50 more than they stake.
    expect((await admin.put<Body>('/api/admin/aviator/settings', { bankroll: 'abc' })).status).toBe(400);
    const on = await admin.put<Body>('/api/admin/aviator/settings', { bankroll: '100', bankroll_floor: '50' });
    expect(on.body.settings).toMatchObject({ house_limit: true, bankroll: 100, bankroll_floor: 50 });

    const round = (await a.client.get<Body>('/api/aviator/game/state')).body;
    expect(round).toMatchObject({ status: 'waiting', limits: { house_limit: true } });
    await app.owner.query('UPDATE aviator_rounds SET crash_point = 50 WHERE id = $1', [round.round_id]);
    const betA = await a.client.post<Body>('/api/aviator/game/bet', { amount: '20' }); // house 120
    expect(betA.status, JSON.stringify(betA.body)).toBe(200);
    // Members stake anything up to their balance (owner, 2026-11-19).
    const betB = await b.client.post<Body>('/api/aviator/game/bet', { amount: '20' }); // house 140
    expect(betB.status).toBe(200);

    // Take-off: (140 - 50) / 40 in the air = 2.25x limit. B cashes out near 2x, which raises the limit.
    const start = Date.parse(round.start_time);
    clock = new Date(start + 7300);
    expect((await a.client.get<Body>('/api/aviator/game/state')).body.status).toBe('active');
    const cashB = await b.client.post<Body>('/api/aviator/game/cashout', { bet_id: betB.body.bet_id });
    expect(cashB.status, JSON.stringify(cashB.body)).toBe(200);
    const houseAfter = 14000 - Math.round(cashB.body.payout * 100); // hundredths
    const limit = Math.floor(((houseAfter - 5000) * 100) / 2000) / 100;
    expect(limit).toBeGreaterThan(2.25);
    expect(limit).toBeLessThan(50);

    // The round ends at the limit; A, still in the air, loses. The seed's crash point is kept and shown.
    clock = new Date(start + (Math.log(limit) / Math.log(1.1)) * 1000 + 300);
    const ended = (await a.client.get<Body>('/api/aviator/game/state')).body;
    expect(ended).toMatchObject({ status: 'crashed', crash_point: limit, seed_crash_point: 50, house_limit: true });
    expect((await a.client.post<Body>('/api/aviator/game/cashout', { bet_id: betA.body.bet_id })).body.error?.code).toBe('aviator.settled');
    expect((await a.client.get<Body>('/api/aviator/wallet/balance')).body.balance).toBe(80);
    expect((await a.client.get<Body>(`/api/aviator/game/verify/${round.round_id}`)).body).toMatchObject({ crash_point: limit, seed_crash_point: 50, house_limit: true, hash_matches: true });
    const house = (await admin.get<Body>('/api/admin/aviator/settings')).body;
    expect(house.bankroll).toBe(houseAfter / 100);
    expect(house.bankroll).toBeGreaterThanOrEqual(house.bankroll_floor);
    expect((await admin.get<Body>(`/api/admin/aviator/rounds/${round.round_id}`)).body.round).toMatchObject({ crash_point: limit, seed_crash_point: 50, house_limit: true });

    // Turning the limit off.
    expect((await admin.put<Body>('/api/admin/aviator/settings', { bankroll: null })).body.settings).toMatchObject({ house_limit: false, bankroll: null });
    app.services.now = () => new Date();
  });

  // Runs after the round test: it starts rounds on the real clock.
  it('is open to signed-in members who have not activated yet (owner, 2026-11-11); other tools stay locked', async () => {
    const m = await registerMember(app, {});
    expect((await m.client.get<Body>('/api/aviator/game/state')).status).toBe(200);
    const added = await m.client.post<Body>('/api/aviator/wallet/deposit', { amount: '50' });
    expect([added.status, added.body.balance]).toEqual([201, 50]);
    expect((await m.client.get<Body>('/api/tips')).body.error?.code).toBe('activation.required');
    // Still only for signed-in members.
    expect((await app.client().get<Body>('/api/aviator/game/state')).status).toBe(401);
  });
});
