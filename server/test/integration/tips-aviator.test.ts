import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drawCrash, multiplierAt } from '../../src/modules/aviator/service.js';
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

describe('aviator (free game points)', () => {
  it('chooses crash points with a 3% edge and grows the multiplier with time', () => {
    expect(drawCrash(() => 0)).toBe(100); // 0.97 rounds up to the 1.00x floor
    expect(drawCrash(() => 0.5)).toBe(194);
    expect(drawCrash(() => 0.999999)).toBe(10_000);
    expect(multiplierAt(0)).toBe(100);
    expect(multiplierAt(10_000)).toBe(201);
  });

  it('takes the stake, pays stake x multiplier on cash-out before the crash, and loses it after', async () => {
    const m = await activated();
    const state = (await m.client.get<Body>('/api/aviator')).body;
    expect(state.points).toBe('1000');
    expect((await m.client.post<Body>('/api/aviator/rounds', { stake: 5 })).body.error?.fields?.stake).toBeDefined();
    expect((await m.client.post<Body>('/api/aviator/rounds', { stake: 5000 })).body.error?.fields?.stake).toBeDefined();

    const started = await m.client.post<Body>('/api/aviator/rounds', { stake: 100 });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body.points).toBe('900');
    expect(started.body.round.crashX100).toBeNull(); // never sent while flying
    const id = started.body.round.id as string;
    await app.owner.query('UPDATE aviator_rounds SET crash_x100 = 10000 WHERE public_id = $1', [id]);
    expect((await m.client.post<Body>('/api/aviator/rounds', { stake: 100 })).body.error?.code).toBe('aviator.flying');
    const cashed = await m.client.post<Body>(`/api/aviator/rounds/${id}/cashout`, {});
    expect(cashed.body.round).toMatchObject({ status: 'cashed', crashX100: 10000 });
    expect(BigInt(cashed.body.points)).toBe(900n + BigInt(cashed.body.round.payout));
    expect(BigInt(cashed.body.round.payout)).toBeGreaterThanOrEqual(100n);

    const lost = await m.client.post<Body>('/api/aviator/rounds', { stake: 200 });
    const lostId = lost.body.round.id as string;
    await app.owner.query(`UPDATE aviator_rounds SET crash_x100 = 100 WHERE public_id = $1`, [lostId]);
    expect((await m.client.get<Body>(`/api/aviator/rounds/${lostId}`)).body.round).toMatchObject({ status: 'crashed', crashX100: 100, payout: '0' });
    const after = await m.client.post<Body>(`/api/aviator/rounds/${lostId}/cashout`, {});
    expect(after.body.round.status).toBe('crashed');
    expect(after.body.points).toBe((BigInt(cashed.body.points) - 200n).toString());
    // Points are not money: no ledger rows.
    expect((await app.owner.query(`SELECT 1 FROM ledger_transactions WHERE ref_type = 'aviator'`)).rowCount).toBe(0);
  });
});
