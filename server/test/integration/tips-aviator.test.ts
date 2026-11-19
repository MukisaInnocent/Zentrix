import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import type { TestClient } from '../helpers/client.js';
import { createStaff, loginStaff, registerMember, type Member } from '../helpers/factories.js';

// Betting tips (owner, 2026-11-06). Aviator has its own file (aviator.test.ts).
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
