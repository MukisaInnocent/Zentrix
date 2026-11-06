import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateCrashPoint, parseAmount } from '../../src/modules/aviator/service.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import type { TestClient } from '../helpers/client.js';
import { createStaff, loginStaff, registerMember, type Member } from '../helpers/factories.js';

// Betting tips and Aviator (owner, 2026-11-06).
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
  it('draws crash points and reads amounts as the project does', () => {
    expect(generateCrashPoint(99)).toBe(1);
    expect(generateCrashPoint(50)).toBe(2);
    expect(generateCrashPoint(0)).toBe(1);
    expect([parseAmount('10'), parseAmount('10.5'), parseAmount('0.01'), parseAmount('1.234'), parseAmount('0'), parseAmount(true)]).toEqual([1000n, 1050n, 1n, null, null, null]);
  });

  it('runs shared rounds: bets only in the window, cash-out at the server multiplier, losses on the crash', async () => {
    const m = await activated();
    // A test clock from the real time (sessions check the clock too).
    const base = Date.now();
    let clock = new Date(base);
    app.services.now = () => clock;
    const at = (seconds: number) => { clock = new Date(base + seconds * 1000); };

    // Demo credits come from a request staff approve, as in the project.
    expect((await m.client.post<Body>('/api/aviator/wallet/deposit', { amount: '100' })).status).toBe(201);
    const pending = (await admin.get<Body>('/api/admin/aviator/requests')).body.requests.find((r: Body) => r.username === m.input.username);
    expect((await support.post<Body>(`/api/admin/aviator/requests/${pending.id}/process`, { action: 'approve' })).status).toBe(403);
    expect((await admin.post<Body>(`/api/admin/aviator/requests/${pending.id}/process`, { action: 'approve' })).status).toBe(200);
    expect((await m.client.get<Body>('/api/aviator/wallet/balance')).body.balance).toBe(100);

    const state = (await m.client.get<Body>('/api/aviator/game/state')).body;
    expect(state.status).toBe('waiting');
    await app.owner.query('UPDATE aviator_rounds SET crash_point = 5 WHERE id = $1', [state.round_id]);
    const bet = await m.client.post<Body>('/api/aviator/game/bet', { amount: '10' });
    expect(bet.status, JSON.stringify(bet.body)).toBe(200);
    expect(bet.body.balance).toBe(90);
    expect((await m.client.post<Body>('/api/aviator/game/bet', { amount: '10' })).status).toBe(409);
    expect((await m.client.post<Body>('/api/aviator/game/bet', { amount: '1.234' })).status).toBe(400);

    at(9); // one second after take-off: 1.1x
    expect((await m.client.get<Body>('/api/aviator/game/state')).body.status).toBe('active');
    expect((await m.client.post<Body>('/api/aviator/game/bet', { amount: '10' })).status).toBe(409);
    const cash = await m.client.post<Body>('/api/aviator/game/cashout', { bet_id: bet.body.bet_id });
    expect(cash.status, JSON.stringify(cash.body)).toBe(200);
    expect(cash.body.multiplier).toBeCloseTo(1.1);
    expect([cash.body.payout, cash.body.balance]).toEqual([11, 101]);

    // Next round: the plane flies away at 1.00x and the bet is lost.
    at(8 + Math.log(5) / Math.log(1.1) + 3.5);
    // As in the project, one poll settles the crash and the next opens the new round.
    expect((await m.client.get<Body>('/api/aviator/game/state')).body.status).toBe('crashed');
    const next = (await m.client.get<Body>('/api/aviator/game/state')).body;
    expect(next.status).toBe('waiting');
    expect(next.round_id).not.toBe(state.round_id);
    await app.owner.query('UPDATE aviator_rounds SET crash_point = 1.5 WHERE id = $1', [next.round_id]);
    const lost = await m.client.post<Body>('/api/aviator/game/bet', { amount: '20' });
    at(8 + Math.log(5) / Math.log(1.1) + 3.5 + 8 + 2); // in flight at 1.21x
    expect((await m.client.get<Body>('/api/aviator/game/state')).body.status).toBe('active');
    at(8 + Math.log(5) / Math.log(1.1) + 3.5 + 8 + 10); // past the 1.5x crash
    expect((await m.client.post<Body>('/api/aviator/game/cashout', { bet_id: lost.body.bet_id })).body.status).toBe('crashed');
    expect((await m.client.get<Body>('/api/aviator/wallet/balance')).body.balance).toBe(81);
    expect((await m.client.get<Body>('/api/aviator/game/history')).body.map((r: Body) => r.crash_point)).toContain(1.5);
    // Demo credits are not money: no ledger rows.
    expect((await app.owner.query(`SELECT 1 FROM ledger_transactions WHERE ref_type = 'aviator'`)).rowCount).toBe(0);
    app.services.now = () => new Date();
  });
});
