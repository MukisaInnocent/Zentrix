import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/tx.js';
import { generateCrashPoint, parseAmount, seedHash } from '../../src/modules/aviator/service.js';
import { accountId, move, post } from '../../src/modules/ledger/ledger.js';
import { runReconciliation } from '../../src/modules/payments/reconciliation.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import type { TestClient } from '../helpers/client.js';
import { createStaff, loginStaff, registerMember, type Member } from '../helpers/factories.js';

// Aviator (owner's project, 2026-11-06), with real money since 2026-11-19 (owner; licence NLGRB-BMTOL-26-0290,
// Uganda): ledger accounts member_aviator and aviator_house, money in from the deposit balance then the main balance,
// money out to the main balance, no bet limits, the house limit on the house money, house money from platform revenue.
let app: TestApp;
let admin: TestClient;
let support: TestClient;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Body = Record<string, any> & { error?: { code: string; fields?: Record<string, string[]> } };
const key = () => ({ 'idempotency-key': randomUUID() });

beforeAll(async () => {
  app = await startTestApp({ TEST_AUTO_APPROVE: 'true' });
  admin = await loginStaff(app, await createStaff(app, ['admin']));
  support = await loginStaff(app, await createStaff(app, ['support']));
  const created = await admin.post('/api/admin/payments/channels', {
    code: 'mtn_aviator_test', name: 'MTN Mobile Money', ussdCode: '*165*3#', merchantCode: '123456', accountNumber: '123456', country: 'UG', accountName: 'PEXEREARN TEST',
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
});
afterAll(async () => {
  await app.close();
});

const userIdOf = async (m: Member) => Number((await app.owner.query<{ id: string }>('SELECT id FROM users WHERE public_id = $1', [m.user.id])).rows[0]!.id);

// Money for the tests, posted straight to the ledger from owner capital through a UGX channel.
async function grant(kind: 'member_deposit' | 'member_main' | 'platform_revenue', amount: bigint, userId?: number): Promise<void> {
  const channelId = Number((await app.owner.query<{ id: string }>(`SELECT id FROM payment_channels WHERE currency_code = 'UGX' ORDER BY id LIMIT 1`)).rows[0]!.id);
  await withTransaction(app.services.pool, async db => {
    const cash = await accountId(db, { kind: 'payment_clearing', channelId, currency: 'UGX' });
    const capital = await accountId(db, { kind: 'owner_capital', currency: 'UGX' });
    const to = kind === 'platform_revenue' ? await accountId(db, { kind, currency: 'UGX' }) : await accountId(db, { kind, userId: userId!, currency: 'UGX' });
    await post(db, { kind: 'test_capital', memo: 'test capital', legs: move(cash, capital, amount) });
    await post(db, { kind: 'test_grant', memo: 'test grant', legs: move(capital, to, amount) });
  });
}

const balanceOf = async (kind: string, userId: number | null) => BigInt((await app.owner.query<{ b: string }>(
  `SELECT coalesce(sum(balance_minor), 0)::text AS b FROM accounts WHERE kind = $1 AND currency_code = 'UGX' AND user_id IS NOT DISTINCT FROM $2`, [kind, userId])).rows[0]!.b);
const house = () => balanceOf('aviator_house', null);

// A test clock past every earlier round, starting from a finished round.
async function freshClock() {
  await app.owner.query(`UPDATE aviator_rounds SET status = 'crashed' WHERE status <> 'crashed'`);
  const last = (await app.owner.query<{ t: Date | null }>('SELECT max(start_time) AS t FROM aviator_rounds')).rows[0]!.t;
  const base = Math.max(Date.now(), (last?.getTime() ?? 0)) + 120_000;
  let clock = new Date(base);
  app.services.now = () => clock;
  return { set: (ms: number) => { clock = new Date(ms); }, base };
}

async function player(): Promise<{ m: Member; id: number }> {
  const m = await registerMember(app, {});
  const { version } = (await m.client.get<Body>('/api/aviator/terms')).body;
  await m.client.post<Body>('/api/aviator/terms/accept', { version });
  return { m, id: await userIdOf(m) };
}

describe('aviator: fairness and amounts', () => {
  it('draws provably fair crash points and reads demo amounts as the project does', () => {
    expect([generateCrashPoint('a'.repeat(64), 0.01), generateCrashPoint('0'.repeat(64), 0.01), generateCrashPoint('deadbeef'.repeat(8), 0.05)]).toEqual([8.14, 2.74, 5.04]);
    expect([generateCrashPoint('seed-1', 0.01), generateCrashPoint('seed-2', 0.05), generateCrashPoint('seed-3', 0.01)]).toEqual([7, 1.11, 10.55]);
    expect(seedHash('seed-1').slice(0, 16)).toBe('0eb026731d9ea3f8');
    expect([parseAmount('10'), parseAmount('10.5'), parseAmount('1.234'), parseAmount('0')]).toEqual([1000n, 1050n, null, null]);
  });
});

describe('aviator with real money (owner, 2026-11-19)', () => {
  it('is closed until an admin switches the currency on, and staff set it up', async () => {
    const { m } = await player();
    expect((await m.client.get<Body>('/api/aviator/game/state')).body).toMatchObject({ status: 'unavailable' });
    expect((await m.client.get<Body>('/api/aviator/wallet/balance')).body).toMatchObject({ available: false, currency: 'UGX' });
    expect((await m.client.post<Body>('/api/aviator/wallet/deposit', { amount: '1000' }, key())).body.error?.code).toBe('aviator.unavailable');
    expect((await m.client.post<Body>('/api/aviator/game/bet', { amount: '1000' }, key())).body.error?.code).toBe('aviator.unavailable');
    expect((await app.client().get<Body>('/api/aviator/game/state')).status).toBe(401);

    // Only admins switch it on and move house money; support only looks.
    expect((await support.put<Body>('/api/admin/aviator/currencies/UGX', { enabled: true })).status).toBe(403);
    expect((await admin.put<Body>('/api/admin/aviator/currencies/UGX', { enabled: true, floor: '10000' })).body.currency).toEqual({ enabled: true, floor: 10000 });
    expect((await admin.put<Body>('/api/admin/aviator/currencies/KES', { enabled: true })).body.error?.code).toBe('aviator.one_currency');
    // House money comes from platform revenue, with a reason, and never goes back below the floor.
    const revenueBefore = await balanceOf('platform_revenue', null);
    await grant('platform_revenue', 200_000n);
    expect((await admin.post<Body>('/api/admin/aviator/house', { currency: 'UGX', direction: 'fund', amount: '60000', reason: '' }, key())).status).toBe(400);
    const funded = await admin.post<Body>('/api/admin/aviator/house', { currency: 'UGX', direction: 'fund', amount: '60000', reason: 'Opening house money' }, key());
    expect(funded.body, JSON.stringify(funded.body)).toMatchObject({ before: 0, after: 60000 });
    expect(await balanceOf('platform_revenue', null)).toBe(revenueBefore + 200_000n - 60_000n);
    expect((await admin.post<Body>('/api/admin/aviator/house', { currency: 'UGX', direction: 'return', amount: '50001', reason: 'Too much' }, key())).body.error?.code).toBe('aviator.below_floor');
    expect((await support.post<Body>('/api/admin/aviator/house', { currency: 'UGX', direction: 'fund', amount: '1', reason: 'test' }, key())).status).toBe(403);
    expect((await support.get<Body>('/api/admin/aviator/money')).body.currencies[0]).toMatchObject({ currency: 'UGX', enabled: true, floor: 10000, house: 60000 });
    expect((await m.client.get<Body>('/api/aviator/game/state')).body.status).not.toBe('unavailable');
  });

  it('moves money in and out, takes bets of any size, pays wins from the house and keeps the ledger whole', async () => {
    const clock = await freshClock();
    const { m, id } = await player();
    await grant('member_deposit', 30_000n, id);
    await grant('member_main', 5_000n, id);

    // In: the deposit balance first, then the main balance; needs an Idempotency-Key; replays move nothing.
    expect((await m.client.post<Body>('/api/aviator/wallet/deposit', { amount: '32000' })).body.error?.code).toBe('idempotency.missing');
    expect((await m.client.post<Body>('/api/aviator/wallet/deposit', { amount: '40000' }, key())).body.error?.code).toBe('aviator.insufficient');
    expect((await m.client.post<Body>('/api/aviator/wallet/deposit', { amount: '10.5' }, key())).status).toBe(400);
    const inKey = key();
    const moved = await m.client.post<Body>('/api/aviator/wallet/deposit', { amount: '32000' }, inKey);
    expect([moved.status, moved.body.balance, moved.body.currency]).toEqual([201, 32000, 'UGX']);
    expect((await m.client.post<Body>('/api/aviator/wallet/deposit', { amount: '32000' }, inKey)).body.balance).toBe(32000);
    expect([await balanceOf('member_deposit', id), await balanceOf('member_main', id), await balanceOf('member_aviator', id)]).toEqual([0n, 3_000n, 32_000n]);
    expect((await m.client.get<Body>('/api/aviator/wallet/transactions')).body[0]).toMatchObject({ type: 'deposit', amount: 32000 });

    // Round 1: a bet of 10,000 (no limits), cashed out at 1.10x: 11,000 paid from the house.
    const houseStart = await house();
    const r1 = (await m.client.get<Body>('/api/aviator/game/state')).body;
    expect(r1).toMatchObject({ status: 'waiting', currency: 'UGX' });
    await app.owner.query('UPDATE aviator_rounds SET crash_point = 5 WHERE id = $1', [r1.round_id]);
    const betKey = key();
    const bet = await m.client.post<Body>('/api/aviator/game/bet', { amount: '10000' }, betKey);
    expect(bet.status, JSON.stringify(bet.body)).toBe(200);
    expect(bet.body.balance).toBe(22000);
    expect((await m.client.post<Body>('/api/aviator/game/bet', { amount: '10000' }, betKey)).body.bet_id).toBe(bet.body.bet_id); // replay
    expect((await m.client.post<Body>('/api/aviator/game/bet', { amount: '100' }, key())).body.error?.code).toBe('aviator.already_bet');
    expect(await balanceOf('member_aviator', id)).toBe(22_000n);
    expect(await house()).toBe(houseStart + 10_000n);

    const start1 = Date.parse(r1.start_time);
    clock.set(start1 + 1000); // 1.1x
    expect((await m.client.get<Body>('/api/aviator/game/state')).body.status).toBe('active');
    // Two cash-outs at once with different keys: exactly one pays.
    const [c1, c2] = await Promise.all([
      m.client.post<Body>('/api/aviator/game/cashout', { bet_id: bet.body.bet_id }, key()),
      m.client.post<Body>('/api/aviator/game/cashout', { bet_id: bet.body.bet_id }, key()),
    ]);
    const paid = [c1, c2].filter(c => c.status === 200);
    expect(paid).toHaveLength(1);
    expect([c1, c2].find(c => c.status !== 200)!.body.error?.code).toBe('aviator.settled');
    expect(paid[0]!.body).toMatchObject({ multiplier: 1.1, payout: 11000, balance: 33000, currency: 'UGX' });
    expect(await balanceOf('member_aviator', id)).toBe(33_000n);
    expect(await house()).toBe(houseStart - 1_000n);

    // Round 2: a big bet that the house limit ends early: (house - floor) / 20,000 in the air.
    clock.set(start1 + 60_000);
    await m.client.get<Body>('/api/aviator/game/state'); // round 1 ends
    const r2 = (await m.client.get<Body>('/api/aviator/game/state')).body; // round 2 opens
    expect(r2.status).toBe('waiting');
    await app.owner.query('UPDATE aviator_rounds SET crash_point = 500 WHERE id = $1', [r2.round_id]);
    const big = await m.client.post<Body>('/api/aviator/game/bet', { amount: '20000' }, key());
    expect(big.status, JSON.stringify(big.body)).toBe(200);
    const houseInFlight = await house();
    const limit = Math.floor(Number(((houseInFlight - 10_000n) * 100n) / 20_000n)) / 100;
    expect(limit).toBeLessThan(500);
    const start2 = Date.parse(r2.start_time);
    clock.set(start2 + (Math.log(limit) / Math.log(1.1)) * 1000 + 300);
    const ended = (await m.client.get<Body>('/api/aviator/game/state')).body;
    expect(ended).toMatchObject({ status: 'crashed', crash_point: limit, seed_crash_point: 500, house_limit: true });
    expect((await m.client.post<Body>('/api/aviator/game/cashout', { bet_id: big.body.bet_id }, key())).body.error?.code).toBe('aviator.settled');
    expect(await balanceOf('member_aviator', id)).toBe(13_000n);
    expect(await house()).toBe(houseInFlight);

    // Out: to the main balance, which the member withdraws as usual.
    expect((await m.client.post<Body>('/api/aviator/wallet/withdraw', { amount: '13001' }, key())).body.error?.code).toBe('aviator.insufficient');
    const out = await m.client.post<Body>('/api/aviator/wallet/withdraw', { amount: '13000' }, key());
    expect([out.status, out.body.balance]).toEqual([201, 0]);
    expect([await balanceOf('member_main', id), await balanceOf('member_aviator', id)]).toEqual([16_000n, 0n]);

    // Staff dashboard: money moved, stakes, payouts and the company's result; players' balances from the ledger.
    const money = (await support.get<Body>('/api/admin/aviator/money')).body.currencies[0];
    expect(money).toMatchObject({ currency: 'UGX', movedIn: 32000, movedOut: 13000, staked: 30000, paid: 11000, companyResult: 19000, inFlight: 0 });
    const p = (await admin.get<Body>(`/api/admin/aviator/players?q=${m.input.username}`)).body.players[0];
    expect(p).toMatchObject({ username: m.input.username, balance: 0, bets: 2, staked: 30000, paid: 11000 });
    expect((await admin.post<Body>(`/api/admin/aviator/players/${p.userId}/balance`, { mode: 'add', amount: '10', reason: 'test' })).body.error?.code).toBe('aviator.real_money');
    const csv = await admin.get<string>('/api/admin/aviator/export/bets.csv');
    expect(String(csv.body).split('\r\n')[0]).toBe('bet_id,round_id,username,currency,amount,result,multiplier,payout,created_at');

    // Every move is in the ledger, and the balance check counts Aviator balances as owed to members.
    const kinds = (await app.owner.query<{ kind: string }>(
      `SELECT DISTINCT t.kind FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id JOIN accounts a ON a.id = e.account_id
       WHERE a.kind = 'member_aviator' AND a.user_id = $1`, [id])).rows.map(r => r.kind).sort();
    expect(kinds).toEqual(['aviator_payout', 'aviator_stake', 'aviator_transfer_in', 'aviator_transfer_out']);
    await m.client.post<Body>('/api/aviator/wallet/deposit', { amount: '5000' }, key());
    const { report } = await runReconciliation(app.services.pool, null);
    const ugx = report.currencies.find(c => c.currency === 'UGX')!;
    expect(BigInt(ugx.memberAviatorMinor)).toBeGreaterThanOrEqual(5_000n);
    expect(report.drift).toEqual([]);
    app.services.now = () => new Date();
  });

  // Security review, 2026-11-19: many cash-outs at once all count at the moment they arrived; house money cannot be
  // taken back while bets are in the air.
  it('pays every player who cashes out at once, and pays a cash-out that arrived before the end but waited', async () => {
    const clock = await freshClock();
    await grant('platform_revenue', 100_000n);
    await admin.post<Body>('/api/admin/aviator/house', { currency: 'UGX', direction: 'fund', amount: '100000', reason: 'More house money' }, key());
    const players = await Promise.all(Array.from({ length: 8 }, () => player()));
    for (const p of players) {
      await grant('member_main', 2_000n, p.id);
      await p.m.client.post<Body>('/api/aviator/wallet/deposit', { amount: '2000' }, key());
    }
    const late = players[0]!;
    await players[1]!.m.client.get<Body>('/api/aviator/game/state'); // the previous round ends
    const round = (await late.m.client.get<Body>('/api/aviator/game/state')).body;
    expect(round.status).toBe('waiting');
    await app.owner.query('UPDATE aviator_rounds SET crash_point = 3 WHERE id = $1', [round.round_id]);
    const bets = await Promise.all(players.map(p => p.m.client.post<Body>('/api/aviator/game/bet', { amount: '1000' }, key())));
    expect(bets.map(b => b.status)).toEqual(Array(8).fill(200));
    // No house money goes back while bets are in the air.
    expect((await admin.post<Body>('/api/admin/aviator/house', { currency: 'UGX', direction: 'return', amount: '1', reason: 'Mid-round' }, key())).body.error?.code).toBe('aviator.bets_in_flight');

    const start = Date.parse(round.start_time);
    clock.set(start + 1000); // 1.1x
    expect((await late.m.client.get<Body>('/api/aviator/game/state')).body.status).toBe('active');
    const outs = await Promise.all(players.slice(1).map((p, i) => p.m.client.post<Body>('/api/aviator/game/cashout', { bet_id: bets[i + 1]!.body.bet_id }, key())));
    expect(outs.map(o => o.status), JSON.stringify(outs.map(o => o.body))).toEqual(Array(7).fill(200));
    expect(outs.every(o => o.body.payout === 1100)).toBe(true);

    // The round ends at 3x and is closed; then a cash-out that arrived at 2.9x is handled: it is paid.
    const crashAt = start + (Math.log(3) / Math.log(1.1)) * 1000;
    clock.set(crashAt + 500);
    expect((await late.m.client.get<Body>('/api/aviator/game/state')).body.status).toBe('crashed');
    clock.set(start + (Math.log(2.9) / Math.log(1.1)) * 1000 + 1);
    const paid = await late.m.client.post<Body>('/api/aviator/game/cashout', { bet_id: bets[0]!.body.bet_id }, key());
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body).toMatchObject({ multiplier: 2.9, payout: 2900, balance: 3900 });
    // A cash-out that arrived after the end is still refused.
    clock.set(crashAt + 600);
    expect((await late.m.client.post<Body>('/api/aviator/game/cashout', { bet_id: bets[0]!.body.bet_id }, key())).body.error?.code).toBe('aviator.settled');
    app.services.now = () => new Date();
  });

  // Owner, 2026-11-19 (after the security review): deposit money must be bet before it can be moved out.
  it('lets deposit money out only once it has been bet; winnings and main-balance money move freely', async () => {
    const clock = await freshClock();
    const { m, id } = await player();
    await grant('member_deposit', 5_000n, id);
    await grant('member_main', 1_000n, id);
    await m.client.post<Body>('/api/aviator/wallet/deposit', { amount: '6000' }, key());
    expect((await m.client.get<Body>('/api/aviator/wallet/balance')).body).toMatchObject({ balance: 6000, mustBet: 5000, withdrawable: 1000 });
    expect((await m.client.post<Body>('/api/aviator/wallet/withdraw', { amount: '1001' }, key())).body.error?.code).toBe('aviator.bet_deposit_first');

    // Bet 3,000 and cash out at 1.1x: 2,000 still to be bet; the winnings move freely.
    await m.client.get<Body>('/api/aviator/game/state');
    const round = (await m.client.get<Body>('/api/aviator/game/state')).body;
    expect(round.status).toBe('waiting');
    await app.owner.query('UPDATE aviator_rounds SET crash_point = 5 WHERE id = $1', [round.round_id]);
    const bet = await m.client.post<Body>('/api/aviator/game/bet', { amount: '3000' }, key());
    expect(bet.status, JSON.stringify(bet.body)).toBe(200);
    clock.set(Date.parse(round.start_time) + 1000);
    await m.client.get<Body>('/api/aviator/game/state');
    expect((await m.client.post<Body>('/api/aviator/game/cashout', { bet_id: bet.body.bet_id }, key())).body.payout).toBe(3300);
    expect((await m.client.get<Body>('/api/aviator/wallet/balance')).body).toMatchObject({ balance: 6300, mustBet: 2000, withdrawable: 4300 });
    expect((await m.client.post<Body>('/api/aviator/wallet/withdraw', { amount: '4301' }, key())).body.error?.code).toBe('aviator.bet_deposit_first');
    const out = await m.client.post<Body>('/api/aviator/wallet/withdraw', { amount: '4300' }, key());
    expect([out.status, out.body.balance]).toEqual([201, 2000]);
    expect(await balanceOf('member_main', id)).toBe(4_300n);
    app.services.now = () => new Date();
  });

  // Owner, 2026-11-20: bets are taken at the floor; the round ends at 1.00x.
  it('takes bets while the house is at its floor and ends those rounds at 1.00x', async () => {
    await freshClock();
    const { m, id } = await player();
    await grant('member_main', 1_000n, id);
    await m.client.post<Body>('/api/aviator/wallet/deposit', { amount: '1000' }, key());
    const back = (await house()) - 10_000n;
    if (back > 0n) {
      const r = await admin.post<Body>('/api/admin/aviator/house', { currency: 'UGX', direction: 'return', amount: back.toString(), reason: 'Test the floor' }, key());
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const round = (await m.client.get<Body>('/api/aviator/game/state')).body;
    expect(round.status).toBe('waiting');
    await app.owner.query('UPDATE aviator_rounds SET crash_point = 5 WHERE id = $1', [round.round_id]);
    const bet = await m.client.post<Body>('/api/aviator/game/bet', { amount: '500' }, key());
    expect(bet.status, JSON.stringify(bet.body)).toBe(200);
    expect(await balanceOf('member_aviator', id)).toBe(500n);
    app.services.now = () => new Date(Date.parse(round.start_time) + 100);
    await m.client.get<Body>('/api/aviator/game/state'); // takes off
    expect((await m.client.get<Body>(`/api/aviator/game/verify/${round.round_id}`)).body).toMatchObject({ crash_point: 1, house_limit: true });
    expect((await m.client.post<Body>('/api/aviator/game/cashout', { bet_id: bet.body.bet_id }, key())).body.error?.code).toBe('aviator.settled');
    app.services.now = () => new Date();
  });

  it('asks for the terms first and keeps the pause switch', async () => {
    await freshClock();
    const m = await registerMember(app, {});
    expect((await m.client.post<Body>('/api/aviator/game/bet', { amount: '100' }, key())).body.error?.code).toBe('aviator.terms_required');
    expect((await m.client.post<Body>('/api/aviator/terms/accept', { version: '2000-01-01' })).body.error?.code).toBe('aviator.terms_changed');
    expect((await admin.put<Body>('/api/admin/aviator/settings', { paused: true, pause_message: 'Back soon' })).body.settings).toMatchObject({ paused: true });
    const { version } = (await m.client.get<Body>('/api/aviator/terms')).body;
    await m.client.post<Body>('/api/aviator/terms/accept', { version });
    expect((await m.client.post<Body>('/api/aviator/game/bet', { amount: '100' }, key())).body.error?.code).toBe('aviator.paused');
    await admin.put<Body>('/api/admin/aviator/settings', { paused: false });
    app.services.now = () => new Date();
  });

  // Last: it switches UGX off. Members can still move their Aviator money out (security review, 2026-11-19).
  it('lets members move their money out after Aviator is switched off', async () => {
    await freshClock();
    const { m, id } = await player();
    await grant('member_main', 3_000n, id);
    await m.client.post<Body>('/api/aviator/wallet/deposit', { amount: '3000' }, key());
    expect((await admin.put<Body>('/api/admin/aviator/currencies/UGX', { enabled: false })).body.currency.enabled).toBe(false);
    expect((await m.client.get<Body>('/api/aviator/wallet/balance')).body).toMatchObject({ available: false, balance: 3000, currency: 'UGX' });
    expect((await m.client.post<Body>('/api/aviator/wallet/deposit', { amount: '100' }, key())).body.error?.code).toBe('aviator.unavailable');
    const out = await m.client.post<Body>('/api/aviator/wallet/withdraw', { amount: '3000' }, key());
    expect([out.status, out.body.balance]).toEqual([201, 0]);
    expect(await balanceOf('member_main', id)).toBe(3_000n);
    expect((await m.client.post<Body>('/api/aviator/wallet/withdraw', { amount: '1000000000000000' }, key())).body.error?.code).toBe('validation_failed');
    app.services.now = () => new Date();
  });
});
