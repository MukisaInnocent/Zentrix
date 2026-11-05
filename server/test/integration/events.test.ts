import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eatDay, FixedVisitsSource } from '../../src/providers/visits.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import type { TestClient } from '../helpers/client.js';
import { createStaff, loginStaff, registerMember } from '../helpers/factories.js';

// Events (owner, 2026-11-05): visitors, registrations and activations per East Africa Time day and by country.
let app: TestApp;
let admin: TestClient;

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call */
type Body = Record<string, any>;

beforeAll(async () => {
  app = await startTestApp();
  admin = await loginStaff(app, await createStaff(app, ['admin']));
});
afterAll(async () => {
  await app.close();
});

describe('events dashboard', () => {
  it('counts members who registered and activated today and overall, and shows visitor counts when there are some', async () => {
    const before = (await admin.get<Body>('/api/admin/events')).body;
    expect(before.visits).toMatchObject({ available: false, since: null });
    expect(before.daily).toHaveLength(30);
    expect(before.daily[0]).toMatchObject({ day: before.today, visitors: null, pageViews: null });

    const a = await registerMember(app);
    await registerMember(app);
    expect((await admin.post<Body>(`/api/admin/payments/members/${a.user.id}/activate`, { note: 'Paid me by phone' }, { 'idempotency-key': randomUUID() })).status).toBe(201);

    const today = eatDay(new Date());
    app.services.visits = new FixedVisitsSource({
      updatedAt: new Date().toISOString(),
      days: [{ day: today, pageViews: 40, visitors: 12, countries: { UG: { pageViews: 30, visitors: 9 }, KE: { pageViews: 10, visitors: 3 } } }],
    });
    const res = await admin.get<Body>('/api/admin/events?days=7');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body;
    expect(body.today).toBe(today);
    expect(body.daily).toHaveLength(7);
    expect(body.daily[0]).toEqual({
      day: today, registrations: before.daily[0].registrations + 2, activations: before.daily[0].activations + 1, visitors: 12, pageViews: 40,
    });
    expect(body.totals).toEqual({ registrations: before.totals.registrations + 2, activations: before.totals.activations + 1 });
    expect(body.period).toMatchObject({ visitors: 12, pageViews: 40 });
    expect(body.visits).toMatchObject({ available: true, since: today, allTime: { visitors: 12, pageViews: 40 } });
    const uganda = body.countries.find((c: Body) => c.code === 'UG');
    expect(uganda).toMatchObject({ name: 'Uganda', visitors: 9, pageViews: 30 });
    expect(uganda.registrations).toBeGreaterThanOrEqual(2);

    expect((await admin.get<Body>('/api/admin/events?days=3')).status).toBe(400);
    expect((await a.client.get<Body>('/api/admin/events')).status).toBe(403);
  });
});
