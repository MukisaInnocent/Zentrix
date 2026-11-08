import { randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyOutcome, checkRequest, livePayWebhook } from '../../src/modules/payments/provider.js';
import { livePaySignature, type PaymentGateway, type ProviderCommand, type ProviderOutcome } from '../../src/providers/livepay.js';
import type { Services } from '../../src/services.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { createStaff, loginStaff, registerMember, type Member } from '../helpers/factories.js';

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

  it('rejects a declined prompt with the reason; the member can try again, up to a daily limit', async () => {
    // The simulator declines numbers ending in 000.
    const member = await registerMember(app, { phone: `+25670${randomInt(1000, 9999)}000` });
    const declined = await collect(member);
    expect(declined.body.deposit).toMatchObject({ status: 'rejected' });
    expect(declined.body.deposit.reviewNote).toMatch(/declined/);
    for (let i = 0; i < 4; i++) expect((await collect(member)).body.deposit.status).toBe('rejected');
    expect((await collect(member)).body.error?.code).toBe('payments.too_many_failed');
  });

  it('deposits any amount the member enters through a prompt, into the deposit balance (owner, 2026-10-31)', async () => {
    const member = await registerMember(app);
    // Only an activated member deposits.
    const early = await member.client.post<Body>('/api/payments/collections', { channel: 'livepay_ug', purpose: 'wallet', amount: '50000' }, key());
    expect(early.body.error?.code).toBe('activation.required');
    expect((await collect(member)).body.deposit.status).toBe('confirmed');
    // A deposit needs an amount; an activation cannot carry one.
    expect((await member.client.post<Body>('/api/payments/collections', { channel: 'livepay_ug', purpose: 'wallet' }, key())).body.error?.fields?.amount).toBeDefined();
    const res = await member.client.post<Body>('/api/payments/collections', { channel: 'livepay_ug', purpose: 'wallet', amount: '50000' }, key());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.deposit).toMatchObject({ purpose: 'wallet', method: 'api', status: 'confirmed', claimedAmountMinor: '50000', creditedAmountMinor: '50000' });
    expect((await member.client.get<Body>('/api/wallet/summary')).body.depositBalanceMinor).toBe('50000');
    expect(await drift()).toBe(0);
  });

  it('sends prompts to any Ugandan number, at most 3 other numbers a day, and keeps the registered number', async () => {
    const member = await registerMember(app);
    const res = await collect(member, '+256772000111');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.deposit).toMatchObject({ status: 'confirmed', senderPhone: '+256772000111' });
    expect((await member.client.get<Body>('/api/me')).body.user).toMatchObject({ phone: member.input.phone });
    const kenyan = await member.client.post<Body>('/api/payments/collections', { channel: 'livepay_ug', purpose: 'wallet', amount: '20000', phone: '+254712000111' }, key());
    expect(kenyan.body.error?.code).toBe('payments.phone_country');
    for (const phone of ['+256772000112', '+256772000113']) {
      expect((await member.client.post<Body>('/api/payments/collections', { channel: 'livepay_ug', purpose: 'wallet', amount: '20000', phone }, key())).status).toBe(201);
    }
    const fourth = await member.client.post<Body>('/api/payments/collections', { channel: 'livepay_ug', purpose: 'wallet', amount: '20000', phone: '+256772000114' }, key());
    expect(fourth.body.error?.code).toBe('payments.too_many_numbers');
    // A number used today and the registered number still work.
    expect((await member.client.post<Body>('/api/payments/collections', { channel: 'livepay_ug', purpose: 'wallet', amount: '20000', phone: '+256772000112' }, key())).status).toBe(201);
    expect((await member.client.post<Body>('/api/payments/collections', { channel: 'livepay_ug', purpose: 'wallet', amount: '20000' }, key())).body.deposit).toMatchObject({ senderPhone: member.input.phone });
  });

  it('raises a critical alert when LivePay reports success after the payment was given up', async () => {
    const member = await registerMember(app);
    const gateway = new HandGateway();
    const deposit = await withGateway(gateway, async () => (await collect(member)).body.deposit as Body);
    const at = new Date().toISOString();
    app.setNow(new Date(Date.now() + 20 * 60_000));
    try {
      await applyOutcome(app.services, { op: 'status', provider: 'simulator', reference: deposit.reference, at, status: 'missing' });
    } finally {
      app.setNow(null);
    }
    expect((await member.client.get<Body>('/api/payments/deposits')).body.deposits[0].status).toBe('rejected');
    await applyOutcome(app.services, { op: 'status', provider: 'simulator', reference: deposit.reference, at, status: 'succeeded', rawStatus: 'Success', amount: '19000', currency: 'UGX' });
    const alert = await app.owner.query(`SELECT severity, details->>'reference' AS reference FROM alerts WHERE kind = 'payments.provider_late_result' AND status = 'open'`);
    expect(alert.rows[0]).toEqual({ severity: 'critical', reference: deposit.reference });
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
  async function fund(): Promise<Member> {
    // Each member takes three collections; start from an empty call log so the file stays within LivePay's budget.
    await app.owner.query('DELETE FROM provider_calls');
    const referrer = await registerMember(app);
    for (let i = 0; i < 2; i++) {
      const invitee = await registerMember(app, { referralCode: referrer.input.username });
      expect((await collect(invitee)).body.deposit.status).toBe('confirmed');
    }
    expect((await collect(referrer)).body.deposit.status).toBe('confirmed');
    await app.owner.query('UPDATE users SET phone_verified_at = now() WHERE username = $1', [referrer.input.username]);
    return referrer;
  }

  async function withdraw(referrer: Member): Promise<Body> {
    const w = await referrer.client.post<Body>('/api/payments/withdrawals', { source: 'main', amount: '15000' }, key());
    expect(w.status, JSON.stringify(w.body)).toBe(201);
    return w.body.withdrawal as Body;
  }

  async function fundedMember(): Promise<{ referrer: Member; withdrawal: Body }> {
    const referrer = await fund();
    return { referrer, withdrawal: await withdraw(referrer) };
  }

  // Runs `fn` with Uganda's approval amount changed, then puts it back.
  async function withUganda<T>(change: { threshold: string }, fn: () => Promise<T>): Promise<T> {
    const admin = await loginStaff(app, await createStaff(app, ['admin']));
    const cfg = (await admin.get<Body>('/api/admin/countries/UG')).body.configHistory[0];
    const edit = (threshold: string, note: string) => ({
      membershipFee: '19000', withdrawalMin: '15000', withdrawalMax: '5000000', withdrawalDailyMax: '5000000', withdrawalFeeBp: cfg.withdrawalFeeBp,
      withdrawalFeeMin: '0', withdrawalApprovalThreshold: threshold, vatBp: 0, kycLevelForWithdrawal: 0,
      engagementTasksEnabled: true, termsVersion: cfg.termsVersion, privacyVersion: cfg.privacyVersion, isPlaceholder: cfg.isPlaceholder, note,
    });
    const original = String(BigInt(cfg.withdrawalApprovalThresholdMinor));
    const changed = await admin.post<Body>('/api/admin/countries/UG/config', edit(change.threshold, 'Test change'));
    expect(changed.status, JSON.stringify(changed.body)).toBe(201);
    try {
      return await fn();
    } finally {
      expect((await admin.post<Body>('/api/admin/countries/UG/config', edit(original, 'Test change undone'))).status).toBe(201);
    }
  }

  const approver = async (reference: string) => (await app.owner.query(
    'SELECT u.username FROM withdrawals w JOIN users u ON u.id = w.approved_by WHERE w.reference = $1', [reference],
  )).rows[0]?.username as string | undefined;

  it('Uganda: pays a withdrawal below UGX 200,000 automatically through LivePay (owner, 2026-10-31)', async () => {
    const { referrer, withdrawal } = await fundedMember();
    expect(withdrawal).toMatchObject({ status: 'paid', payoutMethod: 'api', needsAdminApproval: false, channel: { code: 'livepay_ug' } });
    expect(withdrawal.payoutTxnId).toMatch(/^SIM-/);
    expect(await approver(withdrawal.reference)).toBe('zx_livepay');
    const s = (await referrer.client.get<Body>('/api/wallet/summary')).body;
    expect([s.availableBalanceMinor, s.reservedBalanceMinor, s.totalWithdrawnMinor]).toEqual(['3395', '0', '15000']);
    await new Promise(r => setTimeout(r, 300));
    expect((await app.outbox(referrer.input.email)).map(m => m.subject)).toEqual(expect.arrayContaining([expect.stringMatching(/paid/i)]));
    expect(await drift()).toBe(0);
  });

  it('Uganda: from the approval amount, the withdrawal waits for an admin', async () => {
    // At or above the approval amount (lowered here to UGX 15,000 to keep the test small).
    const large = await withUganda({ threshold: '15000' }, fundedMember);
    expect(large.withdrawal).toMatchObject({ status: 'requested', needsAdminApproval: true });
  });

  it('Uganda: with LivePay off the withdrawal stays for staff; a payout LivePay has not finished stays processing', async () => {
    const off = await fund();
    const member = await fund();
    const gateway = new HandGateway();
    const saved = app.services.payments;
    app.services.payments = null;
    let waiting: Body;
    let pending: Body;
    try {
      waiting = await withdraw(off);
      pending = await withGateway(gateway, () => withdraw(member));
    } finally {
      app.services.payments = saved;
    }
    expect(waiting).toMatchObject({ status: 'requested', needsAdminApproval: false });
    expect(pending).toMatchObject({ status: 'processing', payoutMethod: 'api' });
    expect(gateway.sent.filter(c => c.op === 'payout').map(c => c.reference)).toEqual([pending.reference]);
    // LivePay later reports it paid.
    gateway.status = { status: 'succeeded', rawStatus: 'Success', amount: '15000', currency: 'UGX', providerTxnId: 'MP55667788' };
    await withGateway(gateway, () => checkRequest(app.services, pending.reference as string));
    expect((await member.client.get<Body>('/api/payments/withdrawals')).body.withdrawals[0]).toMatchObject({ status: 'paid', payoutTxnId: 'MP55667788' });
    expect(await drift()).toBe(0);
  });

  it('pays an approved withdrawal through LivePay; one admin approves and sends (owner, 2026-11-08)', async () => {
    const { referrer, withdrawal } = await withUganda({ threshold: '15000' }, fundedMember);
    const admin = await loginStaff(app, await createStaff(app, ['admin', 'finance']));
    const finance = await loginStaff(app, await createStaff(app, ['finance']));
    // Not approved yet: nothing is sent.
    expect((await finance.post<Body>(`/api/admin/payments/withdrawals/${withdrawal.id}/send-provider`, {}, key())).body.error?.code).toBe('withdrawal.wrong_state');
    expect((await admin.post<Body>(`/api/admin/payments/withdrawals/${withdrawal.id}/approve`, {}, key())).status).toBe(200);
    const detail = (await finance.get<Body>(`/api/admin/payments/withdrawals/${withdrawal.id}`)).body;
    expect(detail.provider.payoutChannel).toMatchObject({ code: 'livepay_ug' });

    // The approver sends it too: no second person (owner, 2026-11-08).
    const sent = await admin.post<Body>(`/api/admin/payments/withdrawals/${withdrawal.id}/send-provider`, {}, key());
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.withdrawal).toMatchObject({ status: 'paid', payoutMethod: 'api', channel: { code: 'livepay_ug' } });
    expect(sent.body.withdrawal.payoutTxnId).toMatch(/^SIM-/);
    const s = (await referrer.client.get<Body>('/api/wallet/summary')).body;
    expect([s.availableBalanceMinor, s.reservedBalanceMinor, s.totalWithdrawnMinor]).toEqual(['3395', '0', '15000']);
    expect(await drift()).toBe(0);
  });

  it('returns the hold when LivePay reports the payout failed, but never fails it on "missing" or a refusal alone', async () => {
    const { referrer, withdrawal } = await withUganda({ threshold: '15000' }, fundedMember);
    const admin = await loginStaff(app, await createStaff(app, ['admin', 'finance']));
    const finance = await loginStaff(app, await createStaff(app, ['finance']));
    expect((await admin.post<Body>(`/api/admin/payments/withdrawals/${withdrawal.id}/approve`, {}, key())).status).toBe(200);
    const gateway = new HandGateway();
    await withGateway(gateway, async () => {
      const sent = await finance.post<Body>(`/api/admin/payments/withdrawals/${withdrawal.id}/send-provider`, {}, key());
      expect(sent.body.withdrawal).toMatchObject({ status: 'processing', payoutMethod: 'api' });
      const reference = sent.body.withdrawal.reference as string;
      const at = new Date().toISOString();
      // A refusal (perhaps a retry of a payout LivePay is already paying) does not fail it.
      await applyOutcome(app.services, { op: 'payout', provider: 'simulator', reference, at, accepted: 'no', message: 'Reference already exists' });
      // "Missing" long after: staff review, not an automatic refund.
      app.setNow(new Date(Date.now() + 20 * 60_000));
      try {
        await applyOutcome(app.services, { op: 'status', provider: 'simulator', reference, at, status: 'missing' });
      } finally {
        app.setNow(null);
      }
      const row = (await app.owner.query(`SELECT r.status AS request, w.status AS withdrawal FROM provider_requests r JOIN withdrawals w ON w.id = r.withdrawal_id WHERE w.reference = $1`, [reference])).rows[0];
      expect(row).toEqual({ request: 'review', withdrawal: 'processing' });
      // Staff checked the LivePay dashboard: no money left. Failing it settles the review and returns the hold.
      const failed = await finance.post<Body>(`/api/admin/payments/withdrawals/${withdrawal.id}/fail`, { note: 'Not on the LivePay dashboard.' }, key());
      expect(failed.body.withdrawal).toMatchObject({ status: 'failed' });
    });
    const s = (await referrer.client.get<Body>('/api/wallet/summary')).body;
    expect([s.availableBalanceMinor, s.reservedBalanceMinor]).toEqual(['20000', '0']);
    expect(await drift()).toBe(0);
  });

  it('a failed status read returns the hold', async () => {
    const { referrer, withdrawal } = await withUganda({ threshold: '15000' }, fundedMember);
    const admin = await loginStaff(app, await createStaff(app, ['admin', 'finance']));
    const finance = await loginStaff(app, await createStaff(app, ['finance']));
    expect((await admin.post<Body>(`/api/admin/payments/withdrawals/${withdrawal.id}/approve`, {}, key())).status).toBe(200);
    const gateway = new HandGateway();
    await withGateway(gateway, async () => {
      const sent = await finance.post<Body>(`/api/admin/payments/withdrawals/${withdrawal.id}/send-provider`, {}, key());
      gateway.status = { status: 'failed', rawStatus: 'Failed', message: 'Number cannot receive money' };
      expect(await checkRequest(app.services, sent.body.withdrawal.reference as string)).toBe(true);
    });
    const s = (await referrer.client.get<Body>('/api/wallet/summary')).body;
    expect([s.availableBalanceMinor, s.reservedBalanceMinor]).toEqual(['20000', '0']);
    expect(await drift()).toBe(0);
  });
});
