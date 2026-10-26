import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import type { TestClient } from '../helpers/client.js';
import { createStaff, linkToken, loginStaff, registerMember, type Member } from '../helpers/factories.js';

// Pay For Client activation, the staff referral leaderboard, phone numbers in referral tables and the password
// rules. Payments pass through the test autopilot.
let app: TestApp;
let support: TestClient;

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call */
type Body = Record<string, any> & { error?: { code: string; fields?: Record<string, string[]> } };
const key = () => ({ 'idempotency-key': randomUUID() });
const kenyanPhone = () => `+25471${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;

beforeAll(async () => {
  app = await startTestApp({ TEST_AUTO_APPROVE: 'true' });
  support = await loginStaff(app, await createStaff(app, ['support']));
});
afterAll(async () => {
  await app.close();
});

async function pay(m: Member, extra: Record<string, unknown> = {}): Promise<void> {
  const info = await m.client.get<Body>('/api/payments/channels');
  const res = await m.client.post<Body>('/api/payments/deposits', { channel: info.body.channels[0].code, senderPhone: m.input.phone, providerTxnId: `TEST${randomUUID().slice(0, 8)}`, ...extra }, key());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

async function member(overrides: Record<string, unknown> = {}, activated = true): Promise<Member> {
  const m = await registerMember(app, overrides);
  if (activated) await pay(m);
  return m;
}

const summary = async (m: Member) => (await m.client.get<Body>('/api/wallet/summary')).body;

describe('Pay For Client', () => {
  it('activates a member of the same country from the payer\'s own money and pays the referral rewards', async () => {
    const payer = await member();
    await pay(payer, { purpose: 'wallet', amount: '25000' });
    expect((await summary(payer)).depositBalanceMinor).toBe('25000');
    const inviter = await member();
    const target = await member({ referralCode: inviter.input.username }, false);

    const res = await payer.client.post<Body>('/api/client-payments/activate', { username: `@${target.input.username}` }, key());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ username: target.input.username, feeMinor: '19000' });
    expect(((await target.client.get<Body>('/api/me')).body.user as Body).activated).toBe(true);
    expect((await summary(payer)).depositBalanceMinor).toBe('6000');
    expect((await summary(inviter)).availableBalanceMinor).toBe('10000');
    const history = (await payer.client.get<Body>('/api/client-payments')).body.payments;
    expect(history[0]).toMatchObject({ direction: 'activation', counterparty: target.input.username, amountMinor: '19000' });

    // Already active, another country, or not enough money: refused.
    expect((await payer.client.post<Body>('/api/client-payments/activate', { username: target.input.username }, key())).body.error?.fields?.username).toEqual(['That account is already activated.']);
    const kenyan = await member({ country: 'KE', phone: kenyanPhone() }, false);
    expect((await payer.client.post<Body>('/api/client-payments/activate', { username: kenyan.input.username }, key())).body.error?.fields?.username).toEqual(['That member is in another country.']);
    const other = await member({}, false);
    expect((await payer.client.post<Body>('/api/client-payments/activate', { username: other.input.username }, key())).body.error?.code).toBe('insufficient_funds');
  });

  it('sends money to an activated member without a verified phone, but not to one who has not activated', async () => {
    const payer = await member();
    await pay(payer, { purpose: 'wallet', amount: '5000' });
    const active = await member();
    expect((await payer.client.post<Body>('/api/client-payments', { recipient: active.input.username, amount: '2000' }, key())).status).toBe(201);
    expect((await summary(active)).depositBalanceMinor).toBe('2000');
    const waiting = await member({}, false);
    const refused = await payer.client.post<Body>('/api/client-payments', { recipient: waiting.input.username, amount: '1000' }, key());
    expect(refused.body.error?.fields?.recipient?.[0]).toContain('has not activated');
  });
});

describe('referrals for staff and members', () => {
  it('ranks members by activated direct invites for staff, leaving out staff accounts, and shows invitee phones', async () => {
    const top = await member();
    const a = await member({ referralCode: top.input.username });
    await member({ referralCode: top.input.username });
    await member({ referralCode: a.input.username });

    const board = (await support.get<Body>('/api/admin/leaderboard/referrals')).body.leaders;
    const row = board.find((l: Body) => l.username === top.input.username);
    expect(row).toMatchObject({ activated: 2, invited: 2, rewardsMinor: '25000' });
    expect(board.findIndex((l: Body) => l.username === top.input.username)).toBeLessThan(board.findIndex((l: Body) => l.username === a.input.username));
    const staff = await app.owner.query<{ username: string }>(`SELECT u.username FROM users u JOIN user_roles r ON r.user_id = u.id JOIN roles ro ON ro.name = r.role WHERE ro.is_staff`);
    expect(board.some((l: Body) => staff.rows.some(s => s.username === l.username))).toBe(false);
    expect((await top.client.get<Body>('/api/admin/leaderboard/referrals')).status).toBe(403);

    // Members see the same ranking with usernames and countries only, and their own place.
    const mine = (await top.client.get<Body>('/api/referrals/leaderboard')).body;
    expect(mine.me).toMatchObject({ username: top.input.username, activated: 2, invited: 2 });
    expect(Object.keys(mine.leaders[0]).sort()).toEqual(['activated', 'country', 'invited', 'rank', 'username']);
    expect(mine.leaders.some((l: Body) => staff.rows.some(s => s.username === l.username))).toBe(false);
    const l1 = (await top.client.get<Body>('/api/referrals/members?level=1')).body.members;
    expect(l1.find((m: Body) => m.username === a.input.username).phone).toBe(a.input.phone);
  });
});

describe('passwords', () => {
  it('accepts a short easy member password and keeps staff passwords strong', async () => {
    const m = await registerMember(app, { password: 'sunset' });
    expect(m.user.username).toBeDefined();
    expect((await app.client().post<Body>('/api/auth/register', { ...m.input, username: `${m.input.username}x`.slice(0, 30), email: `x${m.input.email}`, phone: `+25670${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, password: '12345' })).status).toBe(400);
    // A staff account resetting its password must choose a strong one.
    const staff = await createStaff(app, ['finance']);
    const email = (await app.owner.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [staff.userId])).rows[0]!.email;
    expect((await app.client().post('/api/auth/password/forgot', { email })).status).toBe(202);
    const mail = (await app.outbox(email)).find(x => x.subject?.includes('Reset'));
    const token = linkToken(mail!.body, 'token');
    const weak = await app.client().post<Body>('/api/auth/password/reset', { token, password: 'sunset' });
    expect(weak.body.error?.fields?.password).toEqual(expect.arrayContaining(['Use at least 12 characters.', 'Staff passwords need letters, numbers and at least one symbol.']));
    expect((await app.client().post<Body>('/api/auth/password/reset', { token, password: 'sunset-boulevard-7' })).status).toBe(200);
  });
});
