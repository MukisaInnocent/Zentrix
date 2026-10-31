import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fxRatesJob } from '../../src/jobs/fx-rates.js';
import { FixedFxSource } from '../../src/providers/fx.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { registerMember, type Member } from '../helpers/factories.js';

// Owner, 2026-10-31: countries outside the owner's table pay the activation fee in USD (USD 10, rewards USD 4 / 2 / 1)
// while their balances stay in the home currency; vouchers and Pay For Client price the fee at the latest rate.
// Countries without a charge table pay a 3% withdrawal charge. Activation runs through the test autopilot.
let app: TestApp;

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call */
type Body = Record<string, any>;
const key = () => ({ 'idempotency-key': randomUUID() });
const digits = (n: number) => String(randomInt(0, 10 ** n)).padStart(n, '0');
const PHONES: Record<string, () => string> = { ET: () => `+25191${digits(7)}`, NG: () => `+234803${digits(7)}`, TD: () => `+23566${digits(6)}`, CM: () => `+23767${digits(7)}` };

beforeAll(async () => {
  app = await startTestApp({ TEST_AUTO_APPROVE: 'true' });
  app.services.fx = new FixedFxSource({ source: 'test', rateAt: new Date(), unitsPerUsd: { USD: '1', UGX: '3700', ETB: '135', NGN: '1550', XAF: '600' } });
  await fxRatesJob.run(app.services);
});
afterAll(async () => {
  await app.close();
});

async function drift(): Promise<number> {
  const r = await app.owner.query(
    `SELECT 1 FROM accounts a WHERE a.balance_minor <> coalesce((SELECT sum(CASE WHEN e.side = a.normal_side THEN e.amount_minor ELSE -e.amount_minor END) FROM ledger_entries e WHERE e.account_id = a.id), 0)`,
  );
  return r.rowCount ?? 0;
}

// Registers a member and, unless told not to, pays the activation fee on a method in the fee's currency.
async function member(country = 'UG', opts: { referralCode?: string; activate?: boolean } = {}): Promise<Member> {
  const m = await registerMember(app, { ...(country === 'UG' ? {} : { country, phone: PHONES[country]!() }), ...(opts.referralCode ? { referralCode: opts.referralCode } : {}) });
  if (opts.activate === false) return m;
  const info = (await m.client.get<Body>('/api/payments/channels')).body;
  const channel = (info.channels as Body[]).find(c => c.currency === info.activation.feeCurrency && c.depositsEnabled);
  expect(channel, JSON.stringify(info)).toBeDefined();
  const res = await m.client.post<Body>('/api/payments/deposits', { channel: channel!.code, senderPhone: m.input.phone, providerTxnId: `TEST${randomUUID().slice(0, 8)}` }, key());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return m;
}

const summary = async (m: Member) => (await m.client.get<Body>('/api/wallet/summary')).body;

describe('USD activation fee for countries outside the owner\'s table', () => {
  it('charges USD 10 on a USD method, keeps the account in the home currency and shows the fee there', async () => {
    const m = await member('ET', { activate: false });
    const info = (await m.client.get<Body>('/api/payments/channels')).body;
    expect([info.currency, info.activation.feeMinor, info.activation.feeCurrency]).toEqual(['ETB', '1000', 'USD']);
    // A home-currency method cannot take the activation fee.
    const etb = (info.channels as Body[]).find(c => c.currency === 'ETB');
    expect(etb).toBeDefined();
    const wrong = await m.client.post<Body>('/api/payments/deposits', { channel: etb!.code, senderPhone: m.input.phone, providerTxnId: 'TESTWRONG1' }, key());
    expect(wrong.body.error?.code).toBe('payments.channel_unavailable');

    const usd = (info.channels as Body[]).find(c => c.currency === 'USD')!;
    const paid = await m.client.post<Body>('/api/payments/deposits', { channel: usd.code, senderPhone: m.input.phone, providerTxnId: `TEST${randomUUID().slice(0, 8)}` }, key());
    expect(paid.body.deposit).toMatchObject({ claimedAmountMinor: '1000', currency: 'USD' });
    const s = await summary(m);
    expect([s.membershipActive, s.currency, s.membershipFeeMinor, s.membershipFeeCurrency]).toEqual([true, 'ETB', '1000', 'USD']);
    // Expenses show in birr: USD 10 at ETB 135 per dollar.
    expect(s.expensesMinor).toBe('135000');
    const membership = await app.owner.query('SELECT m.fee_minor, m.currency_code FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.username = $1', [m.input.username]);
    expect(membership.rows[0]).toEqual({ fee_minor: '1000', currency_code: 'USD' });
    expect(await drift()).toBe(0);
  });

  it('pays USD 4 / 2 / 1 converted into each inviter\'s currency', async () => {
    const top = await member('UG');
    const mid = await member('ET', { referralCode: top.input.username });
    const direct = await member('ET', { referralCode: mid.input.username });
    const before = [(await summary(top)).availableBalanceMinor, (await summary(mid)).availableBalanceMinor];
    await member('ET', { referralCode: direct.input.username });
    // Level 1 (Ethiopian): USD 4 = ETB 540.00; level 2 (Ethiopian): USD 2 = ETB 270.00; level 3 (Ugandan): USD 1 = UGX 3,700.
    expect((await summary(direct)).availableBalanceMinor).toBe('54000');
    expect(BigInt((await summary(mid)).availableBalanceMinor) - BigInt(before[1])).toBe(27000n);
    expect(BigInt((await summary(top)).availableBalanceMinor) - BigInt(before[0])).toBe(3700n);
    const overview = (await direct.client.get<Body>('/api/referrals')).body;
    expect(overview.tierAmounts.map((t: Body) => t.amountMinor)).toEqual(['400', '200', '100']);
    expect(await drift()).toBe(0);
  });

  it('vouchers and Pay For Client price the USD 10 fee in home currency at the latest rate', async () => {
    const payer = await member('ET');
    const info = (await payer.client.get<Body>('/api/payments/channels')).body;
    const etb = (info.channels as Body[]).find(c => c.currency === 'ETB')!;
    const dep = await payer.client.post<Body>('/api/payments/deposits', { purpose: 'wallet', amount: '3000', channel: etb.code, senderPhone: payer.input.phone, providerTxnId: `TEST${randomUUID().slice(0, 8)}` }, key());
    expect(dep.status, JSON.stringify(dep.body)).toBe(201);
    expect((await summary(payer)).depositBalanceMinor).toBe('300000');

    const vouchers = (await payer.client.get<Body>('/api/vouchers')).body;
    expect([vouchers.currency, vouchers.activationFeeMinor]).toEqual(['ETB', '135000']);

    const client = await member('ET', { activate: false });
    const res = await payer.client.post<Body>('/api/client-payments/activate', { username: client.input.username }, key());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect([res.body.feeMinor, res.body.currency]).toEqual(['135000', 'ETB']);
    expect((await summary(client)).membershipActive).toBe(true);
    expect((await summary(payer)).depositBalanceMinor).toBe('165000');
    const membership = await app.owner.query('SELECT m.fee_minor, m.currency_code FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.username = $1', [client.input.username]);
    expect(membership.rows[0]).toEqual({ fee_minor: '1000', currency_code: 'USD' });

    // A voucher bought in birr activates another Ethiopian; value above the fee goes to their deposit balance.
    const bought = await payer.client.post<Body>('/api/vouchers/buy', { amount: '1500' }, key());
    expect(bought.status, JSON.stringify(bought.body)).toBe(201);
    const second = await member('ET', { activate: false });
    const used = await payer.client.post<Body>('/api/vouchers/activate', { code: bought.body.vouchers[0].code, username: second.input.username }, key());
    expect(used.status, JSON.stringify(used.body)).toBe(200);
    expect((await summary(second)).depositBalanceMinor).toBe('15000');
    expect(await drift()).toBe(0);
  });
});

describe('3% withdrawal charge where there is no charge table', () => {
  it('charges 3% plus the 0.7% tax, before the currency table; Cameroon keeps its XAF table', async () => {
    const quote = async (m: Member, amount: string) => (await m.client.get<Body>(`/api/payments/withdrawals/quote?amount=${amount}`)).body.quote;
    const ng = await member('NG');
    expect(await quote(ng, '1000')).toMatchObject({ chargeMinor: '3000', taxMinor: '700', currency: 'NGN' });
    const et = await member('ET');
    expect(await quote(et, '1000')).toMatchObject({ chargeMinor: '3000', taxMinor: '700', currency: 'ETB' });
    const td = await member('TD');
    expect(await quote(td, '10000')).toMatchObject({ chargeMinor: '300', taxMinor: '70', currency: 'XAF' });
    const cm = await member('CM');
    expect(await quote(cm, '10000')).toMatchObject({ chargeMinor: '950', taxMinor: '70', currency: 'XAF' });
  });
});
