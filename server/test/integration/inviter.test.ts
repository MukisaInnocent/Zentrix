import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { storeRates } from '../../src/modules/fx/service.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import type { TestClient } from '../helpers/client.js';
import { createStaff, loginStaff, registerMember, type Member } from '../helpers/factories.js';

// An admin changes who invited a member; the referral rewards follow the new line. Activation runs through the
// test autopilot so rewards are paid the real way.
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

async function member(overrides: Record<string, unknown> = {}, activated = true): Promise<Member> {
  const m = await registerMember(app, overrides);
  if (activated) await activate(m);
  return m;
}

async function activate(m: Member): Promise<void> {
  const info = await m.client.get<Body>('/api/payments/channels');
  const res = await m.client.post<Body>('/api/payments/deposits', { channel: info.body.channels[0].code, senderPhone: m.input.phone, providerTxnId: `TEST${randomUUID().slice(0, 8)}` }, key());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

const summary = async (m: Member) => (await m.client.get<Body>('/api/wallet/summary')).body;
const changeInviter = (client: TestClient, m: Member, username: string) =>
  client.post<Body>(`/api/admin/members/${m.user.id}/inviter`, { username, reason: 'Member joined with the wrong link' }, key());

describe('changing who invited a member', () => {
  it('moves paid rewards to the new line, leaves a debt for money already used, and repays it from later earnings', async () => {
    const oldInviter = await member();
    const newInviter = await member();
    const u = await member({ referralCode: oldInviter.input.username });
    const d = await member({ referralCode: u.input.username });
    // The old inviter earned 10,000 (U, level 1) + 5,000 (D, level 2), then spent 12,000 of it.
    expect((await summary(oldInviter)).availableBalanceMinor).toBe('15000');
    const spender = await member();
    await app.owner.query('UPDATE users SET phone_verified_at = now() WHERE public_id = $1', [spender.user.id]); // Pay For Client pays verified members only
    expect((await oldInviter.client.post<Body>('/api/client-payments', { recipient: spender.input.username, amount: '12000' }, key())).status).toBe(201);

    expect((await finance.post<Body>(`/api/admin/members/${u.user.id}/inviter`, { username: newInviter.input.username, reason: 'Wrong link used' }, key())).status).toBe(403);
    const res = await changeInviter(admin, u, `@${newInviter.input.username}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ inviter: newInviter.input.username, previousInviter: oldInviter.input.username });
    expect(res.body.moved.map((r: Body) => [r.member, r.level, r.from, r.to, r.amountMinor, r.debtMinor])).toEqual([
      [u.input.username, 1, oldInviter.input.username, newInviter.input.username, '10000', '7000'],
      [d.input.username, 2, oldInviter.input.username, newInviter.input.username, '5000', '5000'],
    ]);

    // The old inviter is now 12,000 below zero; the new inviter has both rewards; U keeps D's level 1 reward.
    const old = await summary(oldInviter);
    expect([old.availableBalanceMinor, old.debtMinor, old.referralEarningsMinor]).toEqual(['-12000', '12000', '0']);
    expect([(await summary(newInviter)).availableBalanceMinor, (await summary(newInviter)).referralEarningsMinor]).toEqual(['15000', '15000']);
    expect((await summary(u)).availableBalanceMinor).toBe('10000');
    expect((await u.client.get<Body>('/api/me')).body.user.referrer).toEqual({ username: newInviter.input.username });
    const lines = await newInviter.client.get<Body>('/api/referrals/members?level=1');
    expect(lines.body.members.map((m: Body) => m.username)).toEqual([u.input.username]);

    // A member with debt cannot spend or withdraw from the balance.
    expect((await oldInviter.client.post<Body>('/api/client-payments', { recipient: spender.input.username, amount: '1000' }, key())).body.error?.code).toBe('insufficient_funds');

    // The old inviter's next referral reward repays the debt first.
    await member({ referralCode: oldInviter.input.username });
    const after = await summary(oldInviter);
    expect([after.availableBalanceMinor, after.debtMinor]).toEqual(['-2000', '2000']);
    const statement = (await oldInviter.client.get<Body>('/api/wallet/transactions?limit=20')).body.transactions;
    expect(statement.some((t: Body) => t.balance === 'debt' && t.amountMinor === '-7000'), JSON.stringify(statement.map((t: Body) => [t.balance, t.amountMinor, t.description]))).toBe(true);

    // Every reward has one receiver, the books balance, and the change is audited.
    const rewards = await app.owner.query<{ level: number; status: string; receiver: string }>(
      `SELECT r.level, r.status, u.username AS receiver FROM referral_rewards r JOIN users u ON u.id = r.referrer_user_id
       JOIN users m ON m.id = r.referred_user_id WHERE m.public_id = $1 ORDER BY r.id`, [u.user.id],
    );
    expect(rewards.rows).toEqual([
      { level: 1, status: 'reversed', receiver: oldInviter.input.username },
      { level: 1, status: 'credited', receiver: newInviter.input.username },
    ]);
    const drift = await app.owner.query(
      `SELECT 1 FROM accounts a WHERE a.balance_minor <> coalesce((SELECT sum(CASE WHEN e.side = a.normal_side THEN e.amount_minor ELSE -e.amount_minor END) FROM ledger_entries e WHERE e.account_id = a.id), 0)`,
    );
    expect(drift.rowCount).toBe(0);
    const audited = await app.owner.query(`SELECT 1 FROM audit_log WHERE action = 'member.inviter_changed' AND target_id = $1`, [u.user.id]);
    expect(audited.rowCount).toBe(1);
  });

  it('pays a member who has not activated nothing yet, and their activation pays the new line', async () => {
    const oldInviter = await member();
    const newInviter = await member();
    const waiting = await member({ referralCode: oldInviter.input.username }, false);
    const res = await changeInviter(admin, waiting, newInviter.input.username);
    expect(res.body.moved).toEqual([]);
    await activate(waiting);
    expect((await summary(newInviter)).availableBalanceMinor).toBe('10000');
    expect((await summary(oldInviter)).availableBalanceMinor).toBe('0');
  });

  it('moves a converted reward back through the exchange account and pays the new inviter in their own currency', async () => {
    await storeRates(app.services.pool, { source: 'test-inviter', rateAt: new Date(), unitsPerUsd: { KES: '129', UGX: '3700' } });
    const oldInviter = await member();
    const newInviter = await member({ country: 'KE', phone: `+25471${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}` });
    const kenyan = await member({ country: 'KE', phone: `+25471${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, referralCode: oldInviter.input.username });
    const paid = BigInt((await summary(oldInviter)).availableBalanceMinor);
    expect(paid).toBeGreaterThan(0n);
    const clearingBefore = await app.owner.query(`SELECT currency_code, balance_minor FROM accounts WHERE kind = 'fx_clearing' ORDER BY currency_code`);

    const res = await changeInviter(admin, kenyan, newInviter.input.username);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.moved).toHaveLength(1);
    expect(res.body.moved[0]).toMatchObject({ from: oldInviter.input.username, to: newInviter.input.username, currency: 'KES', debtMinor: '0', debtCurrency: 'UGX' });
    // The Ugandan gives the shillings back; the Kenyan inviter gets the reward in KES with no conversion.
    expect((await summary(oldInviter)).availableBalanceMinor).toBe('0');
    expect((await summary(newInviter)).availableBalanceMinor).toBe(res.body.moved[0].amountMinor);
    // The reversal undid the conversion exactly, so fx_clearing is back where it was.
    const clearingAfter = await app.owner.query(`SELECT currency_code, balance_minor FROM accounts WHERE kind = 'fx_clearing' ORDER BY currency_code`);
    expect(clearingAfter.rows.map(r => [r.currency_code, r.balance_minor])).toEqual(clearingBefore.rows.map(r => [r.currency_code, r.currency_code === 'KES' ? String(BigInt(r.balance_minor) - BigInt(res.body.moved[0].amountMinor)) : String(BigInt(r.balance_minor) + paid)]));
  });

  it('refuses a loop, the member themselves, the same inviter and an unknown username', async () => {
    const top = await member();
    const u = await member({ referralCode: top.input.username });
    const below = await member({ referralCode: u.input.username });
    expect((await changeInviter(admin, u, below.input.username)).body.error?.fields?.username?.[0]).toContain('cannot be the inviter');
    expect((await changeInviter(admin, u, u.input.username)).body.error?.fields?.username).toEqual(['A member cannot invite themselves.']);
    expect((await changeInviter(admin, u, top.input.username)).body.error?.code).toBe('member.same_inviter');
    expect((await changeInviter(admin, u, 'nobody_has_this_name')).body.error?.fields?.username).toEqual(['No member has that username.']);
    // Outside an audited admin action the database refuses the change.
    await expect(app.owner.query('UPDATE users SET referred_by_user_id = NULL WHERE public_id = $1', [u.user.id])).rejects.toSatisfy(e => (e as { code?: string }).code === 'ZX002');
  });
});
