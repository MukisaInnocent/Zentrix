import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { registerMember, type Member } from '../helpers/factories.js';

// TEST_AUTO_APPROVE (test mode only): activation payments and withdrawals pass by themselves, through the ledger.
let app: TestApp;

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call */
type Body = Record<string, any>;
const key = () => ({ 'idempotency-key': randomUUID() });

beforeAll(async () => {
  app = await startTestApp({ TEST_AUTO_APPROVE: 'true' });
});
afterAll(async () => {
  await app.close();
});

async function activate(member: Member): Promise<Body> {
  const info = await member.client.get<Body>('/api/payments/channels');
  expect(info.body.autoApprove).toBe(true);
  const channel = info.body.channels.find((c: Body) => c.code === 'test_auto_ug');
  expect(channel?.name).toBe('Test payment');
  const res = await member.client.post<Body>('/api/payments/deposits', { channel: channel.code, senderPhone: member.input.phone, providerTxnId: `TEST${randomUUID().slice(0, 8)}` }, key());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

describe('test autopilot', () => {
  it('activates on submit and pays a withdrawal straight away, with every step in the ledger', async () => {
    const referrer = await registerMember(app);
    const member = await registerMember(app, { referralCode: referrer.input.username });
    const second = await registerMember(app, { referralCode: referrer.input.username });
    // The referrer never verifies their phone: in test autopilot mode a demo withdrawal works with one click.

    await activate(referrer);
    await activate(member);
    await activate(second);
    expect(((await member.client.get<Body>('/api/me')).body.user as Body).activated).toBe(true);
    expect((await referrer.client.get<Body>('/api/wallet/summary')).body.availableBalanceMinor).toBe('20000');

    // UGX 15,000 pays the UGX 1,500 charge plus the 0.5% tax (75).
    const w = await referrer.client.post<Body>('/api/payments/withdrawals', { source: 'main', amount: '15000' }, key());
    expect(w.status, JSON.stringify(w.body)).toBe(201);
    const list = await referrer.client.get<Body>('/api/payments/withdrawals');
    expect(list.body.withdrawals[0]).toMatchObject({ status: 'paid' });
    expect(list.body.withdrawals[0].payoutTxnId).toMatch(/^AUTO-/);
    const s = (await referrer.client.get<Body>('/api/wallet/summary')).body;
    expect([s.availableBalanceMinor, s.reservedBalanceMinor, s.totalWithdrawnMinor]).toEqual(['3425', '0', '15000']);

    // The approver and the payer are different system accounts, so the two-person rule still holds.
    const row = (await app.owner.query<{ approver: string; payer: string }>(
      `SELECT a.username AS approver, p.username AS payer FROM withdrawals w JOIN users a ON a.id = w.approved_by JOIN users p ON p.id = w.paid_by WHERE w.public_id = $1`,
      [w.body.withdrawal.id],
    )).rows[0];
    expect(row).toEqual({ approver: 'zx_autopilot_a', payer: 'zx_autopilot_b' });
    const drift = await app.owner.query(
      `SELECT 1 FROM accounts a WHERE a.balance_minor <> coalesce((SELECT sum(CASE WHEN e.side = a.normal_side THEN e.amount_minor ELSE -e.amount_minor END) FROM ledger_entries e WHERE e.account_id = a.id), 0)`,
    );
    expect(drift.rowCount).toBe(0);
  });

  it('gives a member in any country a test payment method', async () => {
    const member = await registerMember(app, { country: 'JP', phone: '+819012345679' });
    const info = await member.client.get<Body>('/api/payments/channels');
    expect(info.body.channels.map((c: Body) => c.code)).toEqual(['test_auto_jp']);
  });
});
