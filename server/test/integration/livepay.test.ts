import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyOutcome, livePayWebhook } from '../../src/modules/payments/provider.js';
import { livePaySignature, type PaymentGateway, type ProviderCommand, type ProviderOutcome } from '../../src/providers/livepay.js';
import type { Services } from '../../src/services.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { createStaff, loginStaff, registerMember, uniquePhoneUG, type Member } from '../helpers/factories.js';

// LivePay (owner, 2026-10-30): activation fees collected and withdrawals paid through the provider API. Test mode runs
// the simulator; a hand-driven gateway covers answers that arrive later (webhook, status reads).
let app: TestApp;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Body = Record<string, any>;
const key = () => ({ 'idempotency-key': randomUUID() });

beforeAll(async () => {
  app = await startTestApp();
  await app.owner.query(
    `INSERT INTO payment_channels (code, name, country_code, currency_code, account_name, account_number, provider)
     VALUES ('livepay_ug', 'Mobile money (LivePay)', 'UG', 'UGX', 'PEXERECORP', 'LP0000000001', 'livepay')`,
  );
});
afterAll(async () => {
  await app.close();
});

// Answers collections and payouts with "accepted" only; status reads return whatever the test sets.
class HandGateway implements PaymentGateway {
  readonly provider = 'simulator' as const;
  sent: ProviderCommand[] = [];
  status: Partial<ProviderOutcome> = { status: 'pending', rawStatus: 'Pending' };
  dispatch(command: ProviderCommand): Promise<ProviderOutcome[]> {
    this.sent.push(command);
    const base = { op: command.op, provider: this.provider, reference: command.reference, at: new Date().toISOString() };
    return Promise.resolve([command.op === 'status' ? { ...base, ...this.status } : { ...base, accepted: 'yes', providerRef: 'lp-ref-1' }]);
  }
}

async function withGateway<T>(gateway: PaymentGateway, fn: () => Promise<T>): Promise<T> {
  const saved = app.services.payments;
  app.services.payments = gateway;
  try {
    return await fn();
  } finally {
    app.services.payments = saved;
  }
}

const collect = (m: Member, phone = m.input.phone, headers = key()) =>
  m.client.post<Body>('/api/payments/collections', { channel: 'livepay_ug', phone }, headers);

async function drift(): Promise<number> {
  const r = await app.owner.query(
    `SELECT 1 FROM accounts a WHERE a.balance_minor <> coalesce((SELECT sum(CASE WHEN e.side = a.normal_side THEN e.amount_minor ELSE -e.amount_minor END) FROM ledger_entries e WHERE e.account_id = a.id), 0)`,
  );
  return r.rowCount ?? 0;
}

describe('LivePay collections', () => {
  it('activates on a successful prompt, pays referral rewards, and confirms as zx_livepay', async () => {
    const referrer = await registerMember(app);
    const member = await registerMember(app, { referralCode: referrer.input.username });
    const channels = (await member.client.get<Body>('/api/payments/channels')).body.channels as Body[];
    expect(channels.find(c => c.code === 'livepay_ug')).toMatchObject({ provider: 'livepay' });

    const res = await collect(member);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.deposit).toMatchObject({ status: 'confirmed', method: 'api', claimedAmountMinor: '19000' });
    expect(((await member.client.get<Body>('/api/me')).body.user as Body).activated).toBe(true);
    expect((await referrer.client.get<Body>('/api/wallet/summary')).body.availableBalanceMinor).toBe('10000');
    const row = (await app.owner.query(
      `SELECT r.status, u.username FROM provider_requests r JOIN deposits d ON d.id = r.deposit_id JOIN users u ON u.id = d.reviewed_by WHERE d.public_id = $1`,
      [res.body.deposit.id],
    )).rows[0];
    expect(row).toEqual({ status: 'succeeded', username: 'zx_livepay' });
    expect(await drift()).toBe(0);
  });

  it('refuses a manual claim on the LivePay method and a repeated request sends no second prompt', async () => {
    const member = await registerMember(app);
    const manual = await member.client.post<Body>('/api/payments/deposits', { channel: 'livepay_ug', senderPhone: member.input.phone, providerTxnId: 'ABC12345' }, key());
    expect(manual.body.error?.code).toBe('payments.channel_method');
    const gateway = new HandGateway();
    await withGateway(gateway, async () => {
      const headers = key();
      expect((await collect(member, member.input.phone, headers)).status).toBe(201);
      expect((await collect(member, member.input.phone, headers)).status).toBe(201);
      expect(gateway.sent.filter(c => c.op === 'collect')).toHaveLength(1);
      // The member cannot cancel a payment on its way, and cannot start a second one.
      const deposit = (await member.client.get<Body>('/api/payments/deposits')).body.deposits[0];
      expect((await member.client.post<Body>(`/api/payments/deposits/${deposit.id}/cancel`, {})).body.error?.code).toBe('deposit.in_flight');
      expect((await collect(member)).body.error?.code).toBe('deposit.too_many_pending');
    });
  });

  it('rejects a declined prompt with the reason, and the member can pay again', async () => {
    const member = await registerMember(app);
    const declined = await collect(member, '+256701230000');
    expect(declined.body.deposit).toMatchObject({ status: 'rejected' });
    expect(declined.body.deposit.reviewNote).toMatch(/declined/);
    const again = await collect(member, uniquePhoneUG());
    expect(again.body.deposit).toMatchObject({ status: 'confirmed' });
  });

  it('credits nothing when the amount read back differs, and staff settle it after review', async () => {
    const member = await registerMember(app);
    const finance = await createStaff(app, ['finance']);
    const staffClient = await loginStaff(app, finance);
    const gateway = new HandGateway();
    const deposit = await withGateway(gateway, async () => (await collect(member)).body.deposit as Body);
    expect(deposit.status).toBe('pending');
    // While LivePay is handling it, staff cannot settle it by hand.
    const early = await staffClient.post<Body>(`/api/admin/payments/deposits/${deposit.id}/confirm`, { amount: '19000' }, key());
    expect(early.body.error?.code).toBe('payments.provider_in_flight');

    await applyOutcome(app.services, {
      op: 'status', provider: 'simulator', reference: deposit.reference, at: new Date().toISOString(), status: 'succeeded', rawStatus: 'Success', amount: '1900', currency: 'UGX',
    });
    const after = (await app.owner.query(`SELECT r.status AS request, d.status AS deposit FROM provider_requests r JOIN deposits d ON d.id = r.deposit_id WHERE d.public_id = $1`, [deposit.id])).rows[0];
    expect(after).toEqual({ request: 'review', deposit: 'pending' });
    const alert = await app.owner.query(`SELECT severity FROM alerts WHERE kind = 'payments.provider_amount_mismatch' AND status = 'open'`);
    expect(alert.rows[0]?.severity).toBe('critical');

    const rejected = await staffClient.post<Body>(`/api/admin/payments/deposits/${deposit.id}/reject`, { reason: 'Amount differs; refunded by LivePay support.' });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    const request = (await app.owner.query(`SELECT r.status FROM provider_requests r JOIN deposits d ON d.id = r.deposit_id WHERE d.public_id = $1`, [deposit.id])).rows[0];
    expect(request?.status).toBe('failed');
  });

  it('a signed webhook triggers a status read; the read, not the webhook, confirms the payment', async () => {
    const member = await registerMember(app);
    const gateway = new HandGateway();
    const secret = 'webhook-secret-for-tests';
    const services: Services = { ...app.services, payments: gateway, config: { ...app.services.config, livepayWebhookSecret: secret } };
    const hook = express();
    hook.post('/hook', express.raw({ type: () => true }), livePayWebhook(services));
    const server = hook.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    try {
      const deposit = await withGateway(gateway, async () => (await collect(member)).body.deposit as Body);
      const payload = { status: 'Success', customer_reference: deposit.reference, internal_reference: 'lp-ref-1', amount: 19000, currency: 'UGX' };
      const t = String(Math.floor(Date.now() / 1000));
      const send = (signature: string) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': signature }, body: JSON.stringify(payload) });

      // The signed URL is the configured webhook address, not the test server's.
      const good = `t=${t},v=${livePaySignature(secret, services.config.livepayWebhookUrl, t, payload)}`;
      expect((await send(`t=${t},v=${'0'.repeat(64)}`)).status).toBe(401);
      // LivePay still says pending: nothing moves.
      expect((await send(good)).status).toBe(200);
      expect((await member.client.get<Body>('/api/payments/deposits')).body.deposits[0].status).toBe('pending');

      gateway.status = { status: 'succeeded', rawStatus: 'Success', amount: '19000', currency: 'UGX', providerTxnId: 'MP99887766', charge: '500' };
      const t2 = String(Math.floor(Date.now() / 1000) + 1);
      expect((await send(`t=${t2},v=${livePaySignature(secret, services.config.livepayWebhookUrl, t2, payload)}`)).status).toBe(200);
      expect((await member.client.get<Body>('/api/payments/deposits')).body.deposits[0].status).toBe('confirmed');
      // A replayed delivery changes nothing.
      expect((await send(`t=${t2},v=${livePaySignature(secret, services.config.livepayWebhookUrl, t2, payload)}`)).status).toBe(200);
      const charge = await app.owner.query(`SELECT count(*)::int AS n FROM ledger_transactions WHERE kind = 'provider_charge' AND ref_id = $1`, [deposit.reference]);
      expect(charge.rows[0]?.n).toBe(1);
      expect(gateway.sent.filter(c => c.op === 'status')).toHaveLength(2);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    expect(await drift()).toBe(0);
  });
});

describe('LivePay payouts', () => {
  async function fundedMember(phone?: string): Promise<{ referrer: Member; withdrawal: Body }> {
    const referrer = await registerMember(app, phone ? { phone } : {});
    for (let i = 0; i < 2; i++) {
      const invitee = await registerMember(app, { referralCode: referrer.input.username });
      expect((await collect(invitee)).body.deposit.status).toBe('confirmed');
    }
    expect((await collect(referrer, uniquePhoneUG())).body.deposit.status).toBe('confirmed');
    await app.owner.query('UPDATE users SET phone_verified_at = now() WHERE username = $1', [referrer.input.username]);
    const w = await referrer.client.post<Body>('/api/payments/withdrawals', { source: 'main', amount: '15000' }, key());
    expect(w.status, JSON.stringify(w.body)).toBe(201);
    return { referrer, withdrawal: w.body.withdrawal };
  }

  it('pays an approved withdrawal through LivePay, with the two-person rule', async () => {
    const { referrer, withdrawal } = await fundedMember();
    const admin = await loginStaff(app, await createStaff(app, ['admin', 'finance']));
    const finance = await loginStaff(app, await createStaff(app, ['finance']));
    // Not approved yet: nothing is sent.
    expect((await finance.post<Body>(`/api/admin/payments/withdrawals/${withdrawal.id}/send-provider`, {}, key())).body.error?.code).toBe('withdrawal.wrong_state');
    expect((await admin.post<Body>(`/api/admin/payments/withdrawals/${withdrawal.id}/approve`, {}, key())).status).toBe(200);
    // The approver cannot also send a new account's payout.
    expect((await admin.post<Body>(`/api/admin/payments/withdrawals/${withdrawal.id}/send-provider`, {}, key())).body.error?.code).toBe('withdrawal.two_people');
    const detail = (await finance.get<Body>(`/api/admin/payments/withdrawals/${withdrawal.id}`)).body;
    expect(detail.provider.payoutChannel).toMatchObject({ code: 'livepay_ug' });

    const sent = await finance.post<Body>(`/api/admin/payments/withdrawals/${withdrawal.id}/send-provider`, {}, key());
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.withdrawal).toMatchObject({ status: 'paid', payoutMethod: 'api', channel: { code: 'livepay_ug' } });
    expect(sent.body.withdrawal.payoutTxnId).toMatch(/^SIM-/);
    const s = (await referrer.client.get<Body>('/api/wallet/summary')).body;
    expect([s.availableBalanceMinor, s.reservedBalanceMinor, s.totalWithdrawnMinor]).toEqual(['3425', '0', '15000']);
    expect(await drift()).toBe(0);
  });

  it('returns the hold when LivePay fails the payout', async () => {
    const { referrer, withdrawal } = await fundedMember('+256709990000');
    const admin = await loginStaff(app, await createStaff(app, ['admin', 'finance']));
    const finance = await loginStaff(app, await createStaff(app, ['finance']));
    expect((await admin.post<Body>(`/api/admin/payments/withdrawals/${withdrawal.id}/approve`, {}, key())).status).toBe(200);
    const sent = await finance.post<Body>(`/api/admin/payments/withdrawals/${withdrawal.id}/send-provider`, {}, key());
    expect(sent.body.withdrawal).toMatchObject({ status: 'failed' });
    const s = (await referrer.client.get<Body>('/api/wallet/summary')).body;
    expect([s.availableBalanceMinor, s.reservedBalanceMinor]).toEqual(['20000', '0']);
    expect(await drift()).toBe(0);
  });
});
