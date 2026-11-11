import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fxRatesJob } from '../../src/jobs/fx-rates.js';
import { FixedFxSource } from '../../src/providers/fx.js';
import { FixedProviderBalance } from '../../src/providers/provider-balance.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import type { TestClient } from '../helpers/client.js';
import { createStaff, loginStaff, registerMember } from '../helpers/factories.js';

// Overall balance (owner, 2026-11-10): received, spent and paid out per currency and in UGX, against the money really
// held, LivePay's own balance first, to show any deficit.
let app: TestApp;
let finance: TestClient;

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call */
type Body = Record<string, any>;
const key = () => ({ 'idempotency-key': randomUUID() });

beforeAll(async () => {
  app = await startTestApp({ TEST_AUTO_APPROVE: 'true' });
  finance = await loginStaff(app, await createStaff(app, ['finance']));
  app.services.fx = new FixedFxSource({ source: 'test', rateAt: new Date(), unitsPerUsd: { USD: '1', UGX: '3700', KES: '129' } });
  await fxRatesJob.run(app.services);
  await app.owner.query(
    `INSERT INTO payment_channels (code, name, country_code, currency_code, account_name, account_number, provider)
     VALUES ('livepay_ug', 'Mobile money (LivePay)', 'UG', 'UGX', 'PEXERECORP', 'LP0000000001', 'livepay')`,
  );
  await app.owner.query(
    `INSERT INTO payment_channels (code, name, country_code, currency_code, account_name, account_number) VALUES ('mpesa_test', 'M-Pesa', 'KE', 'KES', 'PEXEREARN TEST', '000111')`,
  );
});
afterAll(async () => {
  await app.close();
});

describe('overall balance', () => {
  it('adds up what came in and went out, converts it to UGX and compares it with LivePay\'s balance', async () => {
    // Two Ugandans activate through LivePay (the simulator), one inviting the other: UGX 38,000 in, UGX 10,000 owed.
    const referrer = await registerMember(app);
    const collect = (m: { client: TestClient }) => m.client.post<Body>('/api/payments/collections', { channel: 'livepay_ug' }, key());
    expect((await collect(referrer)).body.deposit?.status).toBe('confirmed');
    const invited = await registerMember(app, { referralCode: referrer.input.username });
    expect((await collect(invited)).body.deposit?.status).toBe('confirmed');
    // A Kenyan pays KES 550 by hand (auto-approved in test mode).
    const kenyan = await registerMember(app, { country: 'KE', phone: `+25471${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}` });
    const d = await kenyan.client.post<Body>('/api/payments/deposits', { channel: 'mpesa_test', senderPhone: kenyan.input.phone, providerTxnId: `TX${randomUUID().slice(0, 8)}` }, key());
    expect(d.status, JSON.stringify(d.body)).toBe(201);

    // LivePay holds UGX 1,000 less than the ledger expects.
    app.services.providerBalance = new FixedProviderBalance({ readAt: '2026-11-10T12:00:00.000Z', balances: [{ currency: 'UGX', balance: '37000' }] });
    const res = await finance.get<Body>('/api/admin/overall-balance');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ugx = res.body.currencies.find((c: Body) => c.currency === 'UGX');
    expect(ugx.figures).toMatchObject({ received: '38000', withdrawn: '0', referralRewards: '10000', owedToMembers: '10000', ledgerHeld: '38000', actualHeld: '37000', position: '27000' });
    expect(ugx.livepay).toEqual({ ledgerMinor: '38000', balanceMinor: '37000', differenceMinor: '-1000' });
    expect(ugx.channels.find((c: Body) => c.code === 'livepay_ug')).toMatchObject({ actualSource: 'livepay' });

    // KES 650.00 at KES 129 and UGX 3,700 per dollar = UGX 18,643 (rounded down).
    const kes = res.body.currencies.find((c: Body) => c.currency === 'KES');
    expect(kes.figures).toMatchObject({ received: '65000', ledgerHeld: '65000', actualHeld: '65000', position: '65000' });
    expect(kes.ugx).toMatchObject({ received: '18643', position: '18643' });
    expect(res.body.totalUgx).toMatchObject({ received: String(38000 + 18643), owedToMembers: '10000', position: String(27000 + 18643) });
    expect([res.body.livepayAvailable, res.body.livepayReadAt]).toEqual([true, '2026-11-10T12:00:00.000Z']);
  });

  it('without a LivePay balance it counts the ledger, and only admins and finance see it', async () => {
    app.services.providerBalance = null;
    const res = await finance.get<Body>('/api/admin/overall-balance');
    const ugx = res.body.currencies.find((c: Body) => c.currency === 'UGX');
    expect(ugx.livepay).toEqual({ ledgerMinor: '38000', balanceMinor: null, differenceMinor: null });
    expect(ugx.figures.actualHeld).toBe('38000');
    expect(res.body.livepayAvailable).toBe(false);
    const support = await loginStaff(app, await createStaff(app, ['support']));
    expect((await support.get('/api/admin/overall-balance')).status).toBe(403);
  });
});
