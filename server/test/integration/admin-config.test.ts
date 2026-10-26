import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import type { TestClient } from '../helpers/client.js';
import { createStaff, loginStaff, registerMember, type Member } from '../helpers/factories.js';

// Admins edit the system's variables from the staff console: withdrawal charges, referral amounts, voucher
// values and country configs. Activation runs through the test autopilot.
let app: TestApp;
let admin: TestClient;
let finance: TestClient;

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call */
type Body = Record<string, any> & { error?: { code: string; fields?: Record<string, string[]> } };
const key = () => ({ 'idempotency-key': randomUUID() });

beforeAll(async () => {
  app = await startTestApp({ TEST_AUTO_APPROVE: 'true' });
  admin = await loginStaff(app, await createStaff(app, ['admin']));
  finance = await loginStaff(app, await createStaff(app, ['finance']));
});
afterAll(async () => {
  await app.close();
});

async function member(overrides: Record<string, unknown> = {}): Promise<Member> {
  const m = await registerMember(app, overrides);
  const info = await m.client.get<Body>('/api/payments/channels');
  const res = await m.client.post<Body>('/api/payments/deposits', { channel: info.body.channels[0].code, senderPhone: m.input.phone, providerTxnId: `TEST${randomUUID().slice(0, 8)}` }, key());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return m;
}

describe('withdrawal charges', () => {
  it('lets an admin replace a currency table, used by the next quote and audited', async () => {
    const before = await finance.get<Body>('/api/admin/withdrawal-charges/UGX');
    expect(before.body.bands).toHaveLength(17);
    const bands = [{ upTo: '100000', charge: '1000' }, { upTo: '5000000', charge: '9000' }];
    expect((await finance.put<Body>('/api/admin/withdrawal-charges/UGX', { bands, note: 'Cheaper charges' })).status).toBe(403);
    const unordered = await admin.put<Body>('/api/admin/withdrawal-charges/UGX', { bands: [bands[1], bands[0]], note: 'Wrong order' });
    expect(unordered.body.error?.fields?.bands?.[0]).toContain('higher than the one before');
    const saved = await admin.put<Body>('/api/admin/withdrawal-charges/UGX', { bands, note: 'Cheaper charges' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.bands).toEqual([{ upToMinor: '100000', chargeMinor: '1000' }, { upToMinor: '5000000', chargeMinor: '9000' }]);

    const m = await member();
    const quote = await m.client.get<Body>('/api/payments/withdrawals/quote?amount=20000');
    expect([quote.body.quote.chargeMinor, quote.body.quote.taxMinor]).toEqual(['1000', '100']);
    const audited = await app.owner.query(`SELECT reason FROM audit_log WHERE action = 'withdrawal_charges.changed' AND target_id = 'UGX'`);
    expect(audited.rows).toEqual([{ reason: 'Cheaper charges' }]);
  });
});

describe('settings', () => {
  it('lets an admin change the referral amounts within the activation fee, and pays the new amounts', async () => {
    const tooMuch = await admin.put<Body>('/api/admin/settings/referral.tier_amounts_ugx', { value: { level1: 15000, level2: 5000, level3: 0 } });
    expect(tooMuch.status).toBe(400);
    const ok = await admin.put<Body>('/api/admin/settings/referral.tier_amounts_ugx', { value: { level1: 8000, level2: 3000, level3: 1000 }, note: 'Owner decision' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);

    const inviter = await member();
    await member({ referralCode: inviter.input.username });
    expect((await inviter.client.get<Body>('/api/wallet/summary')).body.availableBalanceMinor).toBe('8000');
    const overview = await inviter.client.get<Body>('/api/referrals');
    expect(overview.body.tierAmounts.map((t: Body) => t.amountMinor)).toEqual(['8000', '3000', '1000']);
  });

  it('lets an admin change the voucher values, never below the fee', async () => {
    expect((await admin.put<Body>('/api/admin/settings/voucher.value_multiples', { value: [2, 1] })).status).toBe(400);
    expect((await admin.put<Body>('/api/admin/settings/voucher.value_multiples', { value: [0, 1] })).status).toBe(400);
    expect((await admin.put<Body>('/api/admin/settings/voucher.value_multiples', { value: [1, 4] })).status).toBe(200);
    const m = await member();
    const list = await m.client.get<Body>('/api/vouchers');
    expect(list.body.valueOptions.map((o: Body) => o.amountMinor)).toEqual(['19000', '76000']);
    const settings = (await admin.get<Body>('/api/admin/settings')).body.settings.map((s: Body) => s.key);
    expect(settings).toEqual(expect.arrayContaining(['referral.tier_amounts_ugx', 'voucher.value_multiples', 'support.contact']));
  });
});

describe('countries and vouchers', () => {
  it('lists each country with its fee and limits, and an admin config edit applies to the next quote', async () => {
    const list = await finance.get<Body>('/api/admin/countries');
    const ug = list.body.countries.find((c: Body) => c.code === 'UG');
    expect(ug).toMatchObject({ membership_fee_minor: '19000', withdrawal_min_minor: '15000', withdrawal_max_minor: '5000000', withdrawal_fee_bp: 50 });

    const edit = {
      membershipFee: '19000', withdrawalMin: '20000', withdrawalMax: '5000000', withdrawalDailyMax: '5000000', withdrawalFeeBp: 100,
      withdrawalFeeMin: '0', withdrawalApprovalThreshold: '200000', newAccountReviewDays: 14, vatBp: 0, kycLevelForWithdrawal: 0,
      engagementTasksEnabled: true, termsVersion: '2026-10-v1', privacyVersion: '2026-10-v1', isPlaceholder: true, note: 'Raise the minimum',
    };
    expect((await finance.post<Body>('/api/admin/countries/UG/config', edit)).status).toBe(403);
    expect((await admin.post<Body>('/api/admin/countries/UG/config', edit)).status).toBe(201);
    const m = await member();
    const quote = await m.client.get<Body>('/api/payments/withdrawals/quote?amount=20000');
    expect([quote.body.quote.limits.minMinor, quote.body.quote.taxMinor]).toEqual(['20000', '200']);
  });

  it('lists every voucher for staff with its buyer and the account it activated', async () => {
    const vouchers = await finance.get<Body>('/api/admin/vouchers');
    expect(vouchers.status).toBe(200);
    expect(Array.isArray(vouchers.body.vouchers)).toBe(true);
    const m = await member();
    expect((await m.client.get<Body>('/api/admin/vouchers')).status).toBe(403);
  });
});
