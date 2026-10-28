import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/tx.js';
import { fxRatesJob } from '../../src/jobs/fx-rates.js';
import { FixedFxSource } from '../../src/providers/fx.js';
import { toDecimalString } from '../../src/lib/money.js';
import { accountId, move, post } from '../../src/modules/ledger/ledger.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import type { TestClient } from '../helpers/client.js';
import { createStaff, loginStaff, registerMember, type Member, type Staff } from '../helpers/factories.js';

// Activation payments and withdrawals, handled by hand, end to end through the HTTP API and the staff console.
let app: TestApp;
let admin: Staff;
let adminClient: TestClient;
let admin2Client: TestClient;
let financeClient: TestClient;
let supportClient: TestClient;

// Response bodies are loosely typed here; the assertions check their shape.
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call */
type Body = Record<string, any> & { error?: { code: string; fields?: Record<string, string[]> } };
const key = () => ({ 'idempotency-key': randomUUID() });
const CHANNEL = 'mtn_test';
const FEE = '19000';

beforeAll(async () => {
  app = await startTestApp();
  admin = await createStaff(app, ['admin']);
  adminClient = await loginStaff(app, admin);
  admin2Client = await loginStaff(app, await createStaff(app, ['admin']));
  financeClient = await loginStaff(app, await createStaff(app, ['finance']));
  supportClient = await loginStaff(app, await createStaff(app, ['support']));
  for (const channel of [
    { code: CHANNEL, name: 'MTN Mobile Money', ussdCode: '*165*3#', merchantCode: '123456', accountNumber: '123456' },
    { code: 'airtel_test', name: 'Airtel Money', ussdCode: '*185*9#', merchantCode: '654321', accountNumber: '654321' },
  ]) {
    const created = await adminClient.post('/api/admin/payments/channels', { ...channel, country: 'UG', accountName: 'PEXEREARN TEST' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
  }
});
afterAll(async () => {
  await app.close();
});

let txnSeq = 0;
const txnId = () => `TX${Date.now().toString(36).toUpperCase()}${(txnSeq++).toString().padStart(3, '0')}`;

async function verifiedMember(overrides: Record<string, unknown> = {}): Promise<Member> {
  const member = await registerMember(app, overrides);
  await app.owner.query('UPDATE users SET phone_verified_at = now() WHERE public_id = $1', [member.user.id]);
  return member;
}

const kenyanPhone = () => `+25471${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;

async function claim(member: Member, extra: Record<string, unknown> = {}) {
  return member.client.post<Body>('/api/payments/deposits', { channel: CHANNEL, senderPhone: member.input.phone, providerTxnId: txnId(), ...extra }, key());
}

// Pays the activation fee the real way: the member claims it, finance confirms it.
async function activate(member: Member): Promise<Body> {
  const res = await claim(member);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const ok = await financeClient.post<Body>(`/api/admin/payments/deposits/${res.body.deposit.id}/confirm`, { amount: FEE }, key());
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  return res.body.deposit;
}

// Puts money on the member's main balance. In production this comes only from referral rewards and vouchers; the
// tests need it to exercise withdrawals, so it is posted straight to the ledger from owner capital.
async function giveBalance(member: Member, amountMinor: bigint): Promise<void> {
  const userId = Number((await app.owner.query<{ id: string }>('SELECT id FROM users WHERE public_id = $1', [member.user.id])).rows[0]!.id);
  const channelId = Number((await app.owner.query<{ id: string }>('SELECT id FROM payment_channels WHERE code = $1', [CHANNEL])).rows[0]!.id);
  await withTransaction(app.services.pool, async db => {
    const cash = await accountId(db, { kind: 'payment_clearing', channelId, currency: 'UGX' });
    const capital = await accountId(db, { kind: 'owner_capital', currency: 'UGX' });
    const main = await accountId(db, { kind: 'member_main', userId, currency: 'UGX' });
    await post(db, { kind: 'test_capital', memo: 'test capital', legs: move(cash, capital, amountMinor) });
    await post(db, { kind: 'test_grant', memo: 'test grant', legs: move(capital, main, amountMinor) });
  });
}

async function fund(member: Member, amount: string): Promise<void> {
  await activate(member);
  await giveBalance(member, BigInt(amount));
}

const summary = async (member: Member) => (await member.client.get<Body>('/api/wallet/summary')).body;

describe('activation payment', () => {
  it('shows the fee and the payment methods for the member country, with USSD and merchant codes', async () => {
    const member = await verifiedMember();
    const res = await member.client.get<Body>('/api/payments/channels');
    expect(res.body.activation).toMatchObject({ active: false, feeMinor: FEE });
    expect(res.body.currency).toBe('UGX');
    const mtn = res.body.channels.find((c: Body) => c.code === CHANNEL);
    expect(mtn).toMatchObject({ name: 'MTN Mobile Money', ussdCode: '*165*3#', merchantCode: '123456' });
    expect(res.body.channels).toHaveLength(2);
  });

  it('offers another country its own fee and no channel it does not have', async () => {
    const kenyan = await verifiedMember({ country: 'KE', phone: kenyanPhone() });
    const res = await kenyan.client.get<Body>('/api/payments/channels');
    expect(res.body.currency).toBe('KES');
    expect(res.body.channels).toEqual([]);
    const config = (await app.owner.query<{ membership_fee_minor: string }>(`SELECT membership_fee_minor FROM current_country_configs WHERE country_code = 'KE'`)).rows[0]!;
    expect(res.body.activation.feeMinor).toBe(config.membership_fee_minor);
    // A Ugandan channel is not available to a Kenyan member.
    expect((await claim(kenyan)).body.error?.code).toBe('payments.channel_unavailable');
  });

  it('keeps the whole site shut until the fee is confirmed, then opens it', async () => {
    const member = await verifiedMember();
    for (const path of ['/api/tasks', '/api/vouchers', '/api/referrals', '/api/payments/withdrawals', '/api/client-payments']) {
      const res = await member.client.get<Body>(path);
      expect([path, res.status, res.body.error?.code]).toEqual([path, 403, 'activation.required']);
    }
    expect((await member.client.get('/api/wallet/summary')).status).toBe(200);
    expect(((await member.client.get<Body>('/api/me')).body.user as Body).activated).toBe(false);
    await activate(member);
    expect(((await member.client.get<Body>('/api/me')).body.user as Body).activated).toBe(true);
    expect((await member.client.get('/api/tasks')).status).toBe(200);
    expect((await member.client.get('/api/referrals')).status).toBe(200);
  });

  it('activates only after staff confirm, exactly once, and keeps the fee as platform revenue', async () => {
    const member = await verifiedMember();
    const noKey = await member.client.post<Body>('/api/payments/deposits', { channel: CHANNEL, senderPhone: member.input.phone, providerTxnId: txnId() });
    expect(noKey.body.error?.code).toBe('idempotency.missing');
    // The member cannot choose the amount: it is always the fee.
    expect((await claim(member, { amount: '1' })).status).toBe(400);
    const res = await claim(member);
    expect(res.status).toBe(201);
    expect(res.body.deposit).toMatchObject({ status: 'pending', claimedAmountMinor: FEE });
    expect((await claim(member)).body.error?.code).toBe('deposit.too_many_pending');
    expect((await summary(member)).membershipActive).toBe(false);
    expect((await summary(member)).pendingDepositsMinor).toBe(FEE);

    const id = res.body.deposit.id;
    const wrong = await financeClient.post<Body>(`/api/admin/payments/deposits/${id}/confirm`, { amount: '18000' }, key());
    expect(wrong.status).toBe(400);
    expect(wrong.body.error?.code).toBe('deposit.wrong_amount');

    const revenueBefore = BigInt((await app.owner.query<{ b: string }>(`SELECT coalesce(sum(balance_minor), 0)::text AS b FROM accounts WHERE kind = 'platform_revenue' AND currency_code = 'UGX'`)).rows[0]!.b);
    const headers = key();
    const first = await financeClient.post<Body>(`/api/admin/payments/deposits/${id}/confirm`, { amount: FEE }, headers);
    const replay = await financeClient.post<Body>(`/api/admin/payments/deposits/${id}/confirm`, { amount: FEE }, headers);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect((await financeClient.post<Body>(`/api/admin/payments/deposits/${id}/confirm`, { amount: FEE }, key())).body.error?.code).toBe('deposit.not_pending');

    const s = await summary(member);
    expect([s.membershipActive, s.availableBalanceMinor, s.expensesMinor, s.netEarningsMinor]).toEqual([true, '0', FEE, `-${FEE}`]);
    const revenueAfter = BigInt((await app.owner.query<{ b: string }>(`SELECT coalesce(sum(balance_minor), 0)::text AS b FROM accounts WHERE kind = 'platform_revenue' AND currency_code = 'UGX'`)).rows[0]!.b);
    expect(revenueAfter - revenueBefore).toBe(19000n);
    expect((await app.owner.query(`SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.public_id = $1 AND m.receipt_no LIKE 'MB-%'`, [member.user.id])).rowCount).toBe(1);

    await new Promise(r => setTimeout(r, 300));
    const mails = (await app.outbox(member.input.email)).map(m => m.subject);
    expect(mails).toContain('Pexerearn: Welcome! Your account is active');
    expect(mails).toContain(`Pexerearn: Activation payment ${res.body.deposit.reference} received`);
    expect(mails.filter(m => m === 'Pexerearn: Welcome! Your account is active')).toHaveLength(1); // the replay sends nothing
    expect((await app.owner.query(`SELECT 1 FROM audit_log WHERE action = 'deposit.confirmed' AND target_id = $1`, [res.body.deposit.reference])).rowCount).toBe(1);
    expect((await claim(member)).body.error?.code).toBe('deposit.already_active');
  });

  it('confirms only once when two staff click at the same time', async () => {
    const member = await verifiedMember();
    const res = await claim(member);
    const both = await Promise.all([
      financeClient.post<Body>(`/api/admin/payments/deposits/${res.body.deposit.id}/confirm`, { amount: FEE }, key()),
      adminClient.post<Body>(`/api/admin/payments/deposits/${res.body.deposit.id}/confirm`, { amount: FEE }, key()),
    ]);
    expect(both.map(r => r.status).sort()).toEqual([200, 409]);
    expect((await summary(member)).membershipActive).toBe(true);
  });

  it('blocks a reused transaction ID, and lets staff reject a payment with a reason so the member can pay again', async () => {
    const a = await verifiedMember();
    const b = await verifiedMember();
    const id = txnId();
    expect((await claim(a, { providerTxnId: id })).status).toBe(201);
    const dup = await claim(b, { providerTxnId: id.toLowerCase() });
    expect(dup.status).toBe(409);
    expect(dup.body.error?.code).toBe('deposit.duplicate_txn');

    const fake = await claim(b);
    const rejected = await financeClient.post<Body>(`/api/admin/payments/deposits/${fake.body.deposit.id}/reject`, { reason: 'No such payment on the statement' });
    expect(rejected.body.deposit.status).toBe('rejected');
    expect((await b.client.get<Body>('/api/payments/deposits')).body.deposits.find((d: Body) => d.id === fake.body.deposit.id).reviewNote).toBe('No such payment on the statement');
    expect((await claim(b)).status).toBe(201);
  });

  it('refuses local-format phone numbers and keeps money actions away from members, support staff and the claimant', async () => {
    const member = await verifiedMember();
    expect((await claim(member, { senderPhone: '0700123456' })).body.error?.fields?.senderPhone).toBeDefined();
    const res = await claim(member, { senderPhone: member.input.phone.replace('+', '') });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.deposit.senderPhone).toBe(member.input.phone);
    expect((await member.client.post<Body>(`/api/admin/payments/deposits/${res.body.deposit.id}/confirm`, { amount: FEE }, key())).status).toBe(403);
    expect((await supportClient.post<Body>(`/api/admin/payments/deposits/${res.body.deposit.id}/confirm`, { amount: FEE }, key())).status).toBe(403);
    expect((await supportClient.get<Body>('/api/admin/payments/deposits?status=pending')).status).toBe(200);
    // A staff member's own payment must be reviewed by someone else.
    const staffMember = await createStaff(app, ['finance']);
    const staffClient = await loginStaff(app, staffMember);
    await app.owner.query('UPDATE users SET phone_verified_at = now() WHERE id = $1', [staffMember.userId]);
    const phone = (await app.owner.query<{ phone_e164: string }>('SELECT phone_e164 FROM users WHERE id = $1', [staffMember.userId])).rows[0]!.phone_e164;
    const own = await staffClient.post<Body>('/api/payments/deposits', { channel: CHANNEL, senderPhone: phone, providerTxnId: txnId() }, key());
    expect((await staffClient.post<Body>(`/api/admin/payments/deposits/${own.body.deposit.id}/confirm`, { amount: FEE }, key())).body.error?.code).toBe('admin.self_action');
  });
});

describe('wallet deposits', () => {
  it('need an activated account, credit the amount actually received, and keep the activation amount fixed', async () => {
    const member = await verifiedMember();
    const wallet = (extra: Record<string, unknown> = {}) => member.client.post<Body>('/api/payments/deposits', {
      purpose: 'wallet', amount: '20000', channel: CHANNEL, senderPhone: member.input.phone, providerTxnId: txnId(), ...extra,
    }, key());
    expect((await wallet()).body.error?.code).toBe('activation.required');
    await activate(member);
    expect((await wallet({ amount: undefined })).body.error?.fields?.amount).toBeDefined();
    const res = await wallet();
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.deposit).toMatchObject({ purpose: 'wallet', claimedAmountMinor: '20000', status: 'pending' });
    const noNote = await financeClient.post<Body>(`/api/admin/payments/deposits/${res.body.deposit.id}/confirm`, { amount: '19500' }, key());
    expect(noNote.body.error?.fields?.note).toBeDefined();
    const ok = await financeClient.post<Body>(`/api/admin/payments/deposits/${res.body.deposit.id}/confirm`, { amount: '19500', note: 'Statement shows 19,500' }, key());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // Deposited money shows under Deposit, never in the balance (which holds referral money only).
    const s = await summary(member);
    expect([s.availableBalanceMinor, s.depositBalanceMinor, s.totalDepositedMinor, s.expensesMinor]).toEqual(['0', '19500', '19500', FEE]);
    await new Promise(r => setTimeout(r, 300));
    expect((await app.outbox(member.input.email)).some(m => m.subject === `Pexerearn: Deposit ${res.body.deposit.reference} credited`)).toBe(true);
    // An activation payment cannot carry an amount of its own.
    const other = await verifiedMember();
    expect((await claim(other, { amount: '100' })).body.error?.fields?.amount).toBeDefined();
  });
});

describe('referral rewards', () => {
  it('pay levels 1 to 3 (10,000 / 5,000 / 2,000) only when the invited member activates, never at sign-up', async () => {
    const top = await verifiedMember();
    const grand = await verifiedMember({ referralCode: top.input.username });
    const referrer = await verifiedMember({ referralCode: grand.input.username.toUpperCase() });
    const member = await verifiedMember({ referralCode: referrer.input.username });
    expect(member.user.referrer).toEqual({ username: referrer.input.username });
    for (const m of [top, grand, referrer, member]) expect((await summary(m)).availableBalanceMinor).toBe('0');

    await activate(member);
    expect((await summary(referrer)).availableBalanceMinor).toBe('10000');
    expect((await summary(grand)).availableBalanceMinor).toBe('5000');
    expect((await summary(top)).availableBalanceMinor).toBe('2000');
    expect((await summary(top)).referralEarningsMinor).toBe('2000');
    expect((await summary(top)).totalEarningsMinor).toBe('2000');
    const levels = await app.owner.query<{ level: number; status: string }>(
      `SELECT r.level, r.status FROM referral_rewards r JOIN users m ON m.id = r.referred_user_id WHERE m.public_id = $1 ORDER BY r.level`, [member.user.id],
    );
    expect(levels.rows).toEqual([{ level: 1, status: 'credited' }, { level: 2, status: 'credited' }, { level: 3, status: 'credited' }]);

    // The referrer's pages list the member as activated at level 1; the top member sees them at level 3.
    await activate(top);
    await activate(referrer);
    const l1 = await referrer.client.get<Body>('/api/referrals/members?level=1&status=active');
    expect(l1.body.members.map((m: Body) => [m.username, m.status])).toEqual([[member.input.username, 'Active']]);
    const l3 = await top.client.get<Body>('/api/referrals/members?level=3');
    expect(l3.body.members.map((m: Body) => m.username)).toEqual([member.input.username]);
    expect((await referrer.client.get<Body>('/api/referrals/members?level=1&status=inactive')).body.members).toEqual([]);
    const overview = await referrer.client.get<Body>('/api/referrals');
    expect(overview.body.upline).toEqual({ username: grand.input.username });
    expect(overview.body.referralLink).toContain(`ref=${referrer.input.username}`);
    expect(overview.body.levels['1']).toEqual({ total: 1, active: 1, inactive: 0, rewardsMinor: '10000' });
    // Each level's overview counts only that level: the top member's level 1 (never activated) earned nothing; level 3 earned 2,000.
    const topLevels = (await top.client.get<Body>('/api/referrals')).body.levels;
    expect([topLevels['1'], topLevels['3']]).toEqual([{ total: 1, active: 0, inactive: 1, rewardsMinor: '0' }, { total: 1, active: 1, inactive: 0, rewardsMinor: '2000' }]);
  });

  it('scale to the invited member country and pay a referrer in another country in their own currency at the latest rate', async () => {
    const ugandan = await verifiedMember();
    await activate(ugandan); // the referral pages need an activated account
    await app.owner.query(
      `INSERT INTO payment_channels (code, name, country_code, currency_code, account_name, account_number) VALUES ('mpesa_test', 'M-Pesa', 'KE', 'KES', 'PEXEREARN TEST', '000111') ON CONFLICT DO NOTHING`,
    );
    const activateKenyan = async (): Promise<bigint> => {
      const kenyan = await verifiedMember({ country: 'KE', phone: kenyanPhone(), referralCode: ugandan.input.username });
      const d = await kenyan.client.post<Body>('/api/payments/deposits', { channel: 'mpesa_test', senderPhone: kenyan.input.phone, providerTxnId: txnId() }, key());
      expect(d.status, JSON.stringify(d.body)).toBe(201);
      const ok = await financeClient.post<Body>(`/api/admin/payments/deposits/${d.body.deposit.id}/confirm`, { amount: toDecimalString(BigInt(d.body.deposit.claimedAmountMinor), 2) }, key());
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect((await summary(kenyan)).membershipActive).toBe(true);
      return BigInt(d.body.deposit.claimedAmountMinor);
    };
    const rewards = () => app.owner.query(
      `SELECT r.status, r.amount_minor, r.currency_code, r.source_amount_minor, r.source_currency_code, r.fx_rate
       FROM referral_rewards r JOIN users u ON u.id = r.referrer_user_id WHERE u.public_id = $1 ORDER BY r.id`, [ugandan.user.id],
    );

    // No exchange rate yet: the level 1 reward (10,000 scaled to Kenya's fee, in KES cents) waits.
    const feeKes = await activateKenyan();
    const rewardKes = (10_000n * feeKes) / 19_000n;
    expect((await summary(ugandan)).availableBalanceMinor).toBe('0');
    expect((await rewards()).rows).toEqual([
      { status: 'pending', amount_minor: null, currency_code: 'UGX', source_amount_minor: rewardKes.toString(), source_currency_code: 'KES', fx_rate: null },
    ]);

    // The rate job stores the rates and pays it: KES 129 and UGX 3,700 per dollar, rounded down to whole shillings.
    // The provider's rate is a month old; the latest rate on file is used however old it is (owner, 2026-10-28).
    app.services.fx = new FixedFxSource({ source: 'test', rateAt: new Date(Date.now() - 30 * 86_400_000), unitsPerUsd: { USD: '1', KES: '129', UGX: '3700' } });
    await fxRatesJob.run(app.services);
    const rewardUgx = (rewardKes * 3700n) / (129n * 100n);
    expect((await summary(ugandan)).availableBalanceMinor).toBe(rewardUgx.toString());
    expect((await rewards()).rows[0]).toMatchObject({ status: 'credited', amount_minor: rewardUgx.toString(), currency_code: 'UGX', fx_rate: '28.682170542636' });

    // With a rate on file, even a month-old one, the next reward is paid at once: nobody waits.
    await activateKenyan();
    expect((await summary(ugandan)).availableBalanceMinor).toBe((2n * rewardUgx).toString());
    expect((await ugandan.client.get<Body>('/api/referrals')).body.levels['1'].rewardsMinor).toBe((2n * rewardUgx).toString());
    const list = (await ugandan.client.get<Body>('/api/referrals/members?level=1')).body.members;
    expect(list.map((m: Body) => [m.currency, m.rewardMinor, m.rewardCurrency])).toEqual([['KES', rewardUgx.toString(), 'UGX'], ['KES', rewardUgx.toString(), 'UGX']]);

    // The money moved through fx_clearing: KES revenue paid it, UGX was credited, and each transaction balances.
    const clearing = await app.owner.query(`SELECT currency_code, balance_minor FROM accounts WHERE kind = 'fx_clearing' ORDER BY currency_code`);
    expect(clearing.rows).toEqual([
      { currency_code: 'KES', balance_minor: (2n * rewardKes).toString() },
      { currency_code: 'UGX', balance_minor: (-2n * rewardUgx).toString() },
    ]);
    const memo = await app.owner.query(`SELECT memo FROM ledger_transactions WHERE kind = 'referral_bonus' AND memo LIKE '%converted from KES%'`);
    expect(memo.rowCount).toBe(2);
  });
});

describe('manual withdrawals', () => {
  it('needs an activated account', async () => {
    const member = await verifiedMember();
    expect((await member.client.post<Body>('/api/payments/withdrawals', { source: 'main', amount: '1000' }, key())).body.error?.code).toBe('activation.required');
  });

  it('holds amount plus the table charge and 0.5% tax, needs an admin approval and a second person to record the payout', async () => {
    const member = await verifiedMember();
    await fund(member, '50000');
    const quote = await member.client.get<Body>('/api/payments/withdrawals/quote?amount=20000');
    expect([quote.body.quote.chargeMinor, quote.body.quote.taxMinor, quote.body.quote.feeMinor]).toEqual(['1500', '100', '1600']);
    expect(quote.body.quote.needsAdminApproval).toBe(true); // new account

    // The member picks no network: the request is assigned one automatically.
    expect((await member.client.post<Body>('/api/payments/withdrawals', { source: 'main', amount: '20000', channel: CHANNEL }, key())).status).toBe(400);
    const res = await member.client.post<Body>('/api/payments/withdrawals', { source: 'main', amount: '20000' }, key());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const id = res.body.withdrawal.id;
    expect(res.body.withdrawal.payoutPhone).toBe(member.input.phone);
    expect(res.body.withdrawal.channel.code).toBe(CHANNEL);
    let s = await summary(member);
    expect([s.availableBalanceMinor, s.reservedBalanceMinor]).toEqual(['28400', '21600']);

    expect((await financeClient.post<Body>(`/api/admin/payments/withdrawals/${id}/approve`, {}, key())).body.error?.code).toBe('withdrawal.admin_required');
    expect((await adminClient.post<Body>(`/api/admin/payments/withdrawals/${id}/approve`, {}, key())).status).toBe(200);
    expect((await adminClient.post<Body>(`/api/admin/payments/withdrawals/${id}/start`, {}, key())).body.error?.code).toBe('withdrawal.two_people');
    expect((await financeClient.post<Body>(`/api/admin/payments/withdrawals/${id}/paid`, { payoutTxnId: 'PAY1' }, key())).body.error?.code).toBe('withdrawal.wrong_state');
    expect((await financeClient.post<Body>(`/api/admin/payments/withdrawals/${id}/start`, {}, key())).status).toBe(200);
    expect((await member.client.post<Body>(`/api/payments/withdrawals/${id}/cancel`, {}, key())).body.error?.code).toBe('withdrawal.not_cancellable');
    // Staff say which network they really paid from; a network with no money in the ledger is refused.
    const detail = await financeClient.get<Body>(`/api/admin/payments/withdrawals/${id}`);
    expect(detail.body.channels.map((c: Body) => c.code).sort()).toEqual(['airtel_test', CHANNEL]);
    expect((await financeClient.post<Body>(`/api/admin/payments/withdrawals/${id}/paid`, { payoutTxnId: `PAY${txnId()}`, channel: 'airtel_test' }, key())).body.error?.code).toBe('withdrawal.channel_short');
    const paid = await financeClient.post<Body>(`/api/admin/payments/withdrawals/${id}/paid`, { payoutTxnId: `PAY${txnId()}` }, key());
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.withdrawal.status).toBe('paid');
    await new Promise(r => setTimeout(r, 300));
    const paidMail = (await app.outbox(member.input.email)).find(m => m.subject?.endsWith(`${res.body.withdrawal.reference} paid`));
    expect(paidMail?.body).toContain('UGX 20,000');
    s = await summary(member);
    expect([s.availableBalanceMinor, s.reservedBalanceMinor, s.totalWithdrawnMinor]).toEqual(['28400', '0', '20000']);
    const fees = await app.owner.query<{ balance_minor: string }>(`SELECT balance_minor FROM accounts WHERE kind = 'fees' AND currency_code = 'UGX'`);
    expect(BigInt(fees.rows[0]!.balance_minor)).toBeGreaterThanOrEqual(1600n);
    await expect(app.owner.query(`UPDATE withdrawals SET status = 'requested' WHERE public_id = $1`, [id])).rejects.toSatisfy(e => (e as { code?: string }).code === 'ZX012');
  });

  it('returns the full hold when the member cancels or the payout fails', async () => {
    const member = await verifiedMember();
    await fund(member, '40000');
    const a = await member.client.post<Body>('/api/payments/withdrawals', { source: 'main', amount: '20000' }, key());
    expect((await member.client.post<Body>(`/api/payments/withdrawals/${a.body.withdrawal.id}/cancel`, {}, key())).body.withdrawal.status).toBe('cancelled');
    expect((await summary(member)).availableBalanceMinor).toBe('40000');

    const b = await member.client.post<Body>('/api/payments/withdrawals', { source: 'main', amount: '20000' }, key());
    await adminClient.post(`/api/admin/payments/withdrawals/${b.body.withdrawal.id}/approve`, {}, key());
    await financeClient.post(`/api/admin/payments/withdrawals/${b.body.withdrawal.id}/start`, {}, key());
    expect((await financeClient.post<Body>(`/api/admin/payments/withdrawals/${b.body.withdrawal.id}/fail`, {}, key())).body.error?.fields?.note).toBeDefined();
    const failed = await financeClient.post<Body>(`/api/admin/payments/withdrawals/${b.body.withdrawal.id}/fail`, { note: 'Number not registered for mobile money' }, key());
    expect(failed.body.withdrawal.status).toBe('failed');
    const s = await summary(member);
    expect([s.availableBalanceMinor, s.reservedBalanceMinor]).toEqual(['40000', '0']);
  });

  it('cannot overdraw with simultaneous requests, and enforces the minimum and a verified phone', async () => {
    const member = await verifiedMember();
    await fund(member, '30000');
    const results = await Promise.all(
      Array.from({ length: 4 }, () => member.client.post<Body>('/api/payments/withdrawals', { source: 'main', amount: '20000' }, key())),
    );
    expect(results.filter(r => r.status === 201)).toHaveLength(1);
    expect((await summary(member)).availableBalanceMinor).toBe('8400');
    // Withdrawals run from UGX 15,000 to UGX 5,000,000.
    const tooSmall = await member.client.post<Body>('/api/payments/withdrawals', { source: 'main', amount: '14999' }, key());
    expect(tooSmall.body.error?.fields?.amount).toEqual(['This is below the minimum withdrawal.']);
    const table = await member.client.get<Body>('/api/payments/withdrawals/charges');
    expect([table.body.minMinor, table.body.maxMinor, table.body.taxBasisPoints, table.body.bands.length]).toEqual(['15000', '5000000', 50, 17]);
    expect(table.body.bands[0]).toEqual({ fromMinor: '15000', upToMinor: '50000', chargeMinor: '1500' });
    expect(table.body.bands[16]).toEqual({ fromMinor: '3000000', upToMinor: '5000000', chargeMinor: '26500' });

    const unverified = await registerMember(app);
    await activate(unverified);
    expect((await unverified.client.post<Body>('/api/payments/withdrawals', { source: 'main', amount: '15000' }, key())).body.error?.code).toBe('withdrawal.phone_unverified');
  });
});

describe('balance check, pauses and alerts', () => {
  it('pauses withdrawals when the channel statement shows less than members are owed', async () => {
    const member = await verifiedMember();
    await fund(member, '40000');
    const clean = await financeClient.post<Body>('/api/admin/payments/reconciliation/run', {});
    expect(clean.body.report.ok, JSON.stringify(clean.body.report)).toBe(true);

    expect((await financeClient.post<Body>('/api/admin/payments/float-snapshots', { channel: CHANNEL, balance: '0', note: 'Statement read' })).status).toBe(201);
    const failing = await financeClient.post<Body>('/api/admin/payments/reconciliation/run', {});
    const ugx = failing.body.report.currencies.find((c: Body) => c.currency === 'UGX');
    expect(ugx.ok).toBe(false);
    expect(ugx.findings.map((f: Body) => f.kind)).toContain('solvency');

    const blocked = await member.client.post<Body>('/api/payments/withdrawals', { source: 'main', amount: '15000' }, key());
    expect(blocked.status).toBe(503);
    expect(blocked.body.error?.code).toBe('payments.withdrawals_paused');
    expect((await adminClient.post<Body>('/api/admin/payments/flags', { key: 'withdrawals_paused', currency: 'UGX', active: false, reason: 'Trying to resume' })).body.error?.code).toBe('flags.check_failing');
    const overview = await supportClient.get<Body>('/api/admin/payments/overview');
    expect(overview.body.alerts.some((a: Body) => a.kind === 'reconciliation.solvency' && a.severity === 'critical')).toBe(true);
    expect(Number(overview.body.counts.alerts_open)).toBeGreaterThan(0);

    // Statement corrected: the check passes and an admin resumes withdrawals.
    const ledgerHeld = ugx.channels.find((c: Body) => c.code === CHANNEL).ledgerHeldMinor;
    await financeClient.post('/api/admin/payments/float-snapshots', { channel: CHANNEL, balance: ledgerHeld, note: 'Corrected statement' });
    expect((await financeClient.post<Body>('/api/admin/payments/reconciliation/run', {})).body.report.ok).toBe(true);
    expect((await financeClient.post<Body>('/api/admin/payments/flags', { key: 'withdrawals_paused', currency: 'UGX', active: false, reason: 'Check passes again' })).body.error?.code).toBe('flags.admin_required');
    expect((await adminClient.post<Body>('/api/admin/payments/flags', { key: 'withdrawals_paused', currency: 'UGX', active: false, reason: 'Check passes again' })).status).toBe(200);
    expect((await member.client.post<Body>('/api/payments/withdrawals', { source: 'main', amount: '15000' }, key())).status).toBe(201);
  });
});

describe('treasury and task budget', () => {
  it('needs a different admin to approve, and task rewards stop when the budget is empty', async () => {
    const member = await verifiedMember();
    await activate(member);
    const tasks = await member.client.get<Body>('/api/tasks?module=youtube');
    const task = tasks.body.tasks[0];
    expect((await member.client.post<Body>(`/api/tasks/${task.id}/complete`, { answer: 'done' }, key())).body.error?.code).toBe('task.budget_empty');

    const capital = await financeClient.post<Body>('/api/admin/payments/treasury', { kind: 'capital_in', currency: 'UGX', amount: '100000', channel: CHANNEL, externalRef: 'OWNER-1', note: 'Owner capital for tests' });
    expect(capital.status, JSON.stringify(capital.body)).toBe(201);
    expect((await financeClient.post<Body>(`/api/admin/payments/treasury/${capital.body.id}/decide`, { approve: true }, key())).status).toBe(403);
    expect((await adminClient.post<Body>(`/api/admin/payments/treasury/${capital.body.id}/decide`, { approve: true }, key())).status).toBe(200);

    const own = await adminClient.post<Body>('/api/admin/payments/treasury', { kind: 'fund_budget', currency: 'UGX', amount: '5000', source: 'owner_capital', budget: 'promotions_budget', note: 'Task budget' });
    expect((await adminClient.post<Body>(`/api/admin/payments/treasury/${own.body.id}/decide`, { approve: true }, key())).body.error?.code).toBe('treasury.same_person');
    expect((await admin2Client.post<Body>(`/api/admin/payments/treasury/${own.body.id}/decide`, { approve: true }, key())).status).toBe(200);

    const done = await member.client.post<Body>(`/api/tasks/${task.id}/complete`, { answer: 'done' }, key());
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const s = await summary(member);
    // Task earnings stay out of the main balance (which holds referral money only) but count in total earnings.
    expect([s.taskBalancesMinor.youtube, s.availableBalanceMinor, s.taskEarningsMinor, s.totalEarningsMinor]).toEqual([task.rewardMinor, '0', task.rewardMinor, task.rewardMinor]);
    expect(BigInt(s.netEarningsMinor)).toBe(BigInt(task.rewardMinor) - 19000n);
    const trivia = await member.client.get<Body>('/api/tasks?module=trivia');
    expect(JSON.stringify(trivia.body)).not.toContain('"answer"');
  });
});

describe('payment issues', () => {
  it('lets a member report a problem on their own payment, emails them the staff reply, and keeps the thread private', async () => {
    const member = await verifiedMember();
    const other = await verifiedMember();
    const res = await claim(member);
    const ref = res.body.deposit.reference;
    expect((await other.client.post<Body>('/api/payments/issues', { subjectType: 'deposit', reference: ref, category: 'not_credited', message: 'I sent this money an hour ago.' })).status).toBe(400);
    const opened = await member.client.post<Body>('/api/payments/issues', { subjectType: 'deposit', reference: ref, category: 'not_credited', message: 'I sent this money an hour ago.' });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const id = opened.body.issue.id;

    const queue = await supportClient.get<Body>('/api/admin/payments/issues?status=unresolved');
    expect(queue.body.issues.find((i: Body) => i.id === id).awaitingStaff).toBe(true);
    await supportClient.post(`/api/admin/payments/issues/${id}/messages`, { body: 'We are checking the statement now.' });
    await new Promise(r => setTimeout(r, 300));
    const reply = (await app.outbox(member.input.email)).find(m => m.subject === 'Pexerearn: reply to your payment report');
    expect(reply?.body).toContain('We are checking the statement now.');
    expect((await supportClient.post<Body>(`/api/admin/payments/issues/${id}/status`, { status: 'resolved' })).body.error?.fields?.resolution).toBeDefined();
    await supportClient.post(`/api/admin/payments/issues/${id}/status`, { status: 'resolved', resolution: 'Payment confirmed by finance.' });

    const thread = await member.client.get<Body>(`/api/payments/issues/${id}`);
    expect(thread.body.issue.status).toBe('resolved');
    expect(thread.body.messages.map((m: Body) => m.author)).toEqual([member.input.username, 'Pexerearn support', 'Pexerearn support']);
    expect((await other.client.get<Body>(`/api/payments/issues/${id}`)).status).toBe(404);
  });
});

describe('ledger explorer', () => {
  it('shows balanced entries for every transaction', async () => {
    const res = await financeClient.get<Body>('/api/admin/payments/ledger');
    expect(res.status).toBe(200);
    for (const t of res.body.transactions) {
      const sum = t.entries.reduce((acc: bigint, e: Body) => acc + (e.side === 'debit' ? BigInt(e.amountMinor) : -BigInt(e.amountMinor)), 0n);
      expect(sum).toBe(0n);
    }
    expect((await supportClient.get<Body>('/api/admin/payments/ledger')).status).toBe(403);
  });
});

describe('vouchers', () => {
  it('offers only values of at least the activation fee and refuses a cheaper voucher', async () => {
    const buyer = await verifiedMember();
    await fund(buyer, '100000');
    const list = await buyer.client.get<Body>('/api/vouchers');
    expect(list.body.activationFeeMinor).toBe(FEE);
    expect(list.body.valueOptions.map((o: Body) => o.amountMinor)).toEqual(['19000', '38000', '57000', '95000']);
    const cheap = await buyer.client.post<Body>('/api/vouchers/buy', { amount: '18999', quantity: 1 }, key());
    expect([cheap.status, cheap.body.error?.fields?.amount]).toEqual([400, ['Must be at least the activation fee.']]);
    expect((await summary(buyer)).availableBalanceMinor).toBe('100000');
    // Vouchers no longer go into a wallet: they only activate accounts.
    expect((await buyer.client.post<Body>('/api/vouchers/redeem', { code: 'ZX-AAAA-BBBB-CCCC' }, key())).status).toBe(404);
  });

  it('activates another member once, pays the referral rewards and credits any value above the fee', async () => {
    const buyer = await verifiedMember();
    await fund(buyer, '38000');
    const referrer = await verifiedMember();
    await activate(referrer);
    const target = await verifiedMember({ referralCode: referrer.input.username });
    const bought = await buyer.client.post<Body>('/api/vouchers/buy', { amount: '38000', quantity: 1 }, key());
    expect(bought.status, JSON.stringify(bought.body)).toBe(201);
    const code = bought.body.vouchers[0].code as string;
    expect((await summary(buyer)).availableBalanceMinor).toBe('0');

    const headers = key();
    const res = await buyer.client.post<Body>('/api/vouchers/activate', { code, username: `@${target.input.username.toUpperCase()}` }, headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.username).toBe(target.input.username);
    const replay = await buyer.client.post<Body>('/api/vouchers/activate', { code, username: `@${target.input.username.toUpperCase()}` }, headers);
    expect(replay.body).toEqual(res.body);

    expect(((await target.client.get<Body>('/api/me')).body.user as Body).activated).toBe(true);
    expect([(await summary(target)).availableBalanceMinor, (await summary(target)).depositBalanceMinor]).toEqual(['0', '19000']);
    expect((await summary(referrer)).referralEarningsMinor).toBe('10000');
    const fees = await app.owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.public_id = $1 AND m.fee_minor = 19000`, [target.user.id],
    );
    expect(fees.rows[0]!.n).toBe('1');
    const mine = (await buyer.client.get<Body>('/api/vouchers')).body.vouchers[0];
    expect(mine).toMatchObject({ code, status: 'used', usedBy: target.input.username });

    // A used voucher cannot be used again, even for another account.
    const other = await verifiedMember();
    expect((await buyer.client.post<Body>('/api/vouchers/activate', { code, username: other.input.username }, key())).body.error?.code).toBe('voucher.already_used');
  });

  it('refuses an activated account, an unknown username and another member\'s voucher', async () => {
    const buyer = await verifiedMember();
    await fund(buyer, '19000');
    const code = (await buyer.client.post<Body>('/api/vouchers/buy', { amount: FEE, quantity: 1 }, key())).body.vouchers[0].code as string;
    const active = await verifiedMember();
    await activate(active);
    const already = await buyer.client.post<Body>('/api/vouchers/activate', { code, username: active.input.username }, key());
    expect(already.body.error?.fields?.username).toEqual(['That account is already activated.']);
    const unknown = await buyer.client.post<Body>('/api/vouchers/activate', { code, username: 'no_such_member_x' }, key());
    expect(unknown.body.error?.fields?.username).toEqual(['No member has that username.']);
    // Someone else cannot spend the buyer's voucher.
    const target = await verifiedMember();
    expect((await active.client.post<Body>('/api/vouchers/activate', { code, username: target.input.username }, key())).status).toBe(404);
    expect(((await target.client.get<Body>('/api/me')).body.user as Body).activated).toBe(false);
    expect((await buyer.client.get<Body>('/api/vouchers')).body.vouchers[0].status).toBe('active');
  });
});

describe('deposit balance', () => {
  // Confirms a wallet deposit the real way: the member claims it, finance confirms it.
  async function deposit(member: Member, amount: string): Promise<void> {
    const res = await member.client.post<Body>('/api/payments/deposits', { purpose: 'wallet', amount, channel: CHANNEL, senderPhone: member.input.phone, providerTxnId: txnId() }, key());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const ok = await financeClient.post<Body>(`/api/admin/payments/deposits/${res.body.deposit.id}/confirm`, { amount }, key());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  }

  it('spends the deposit first, then the balance, and Pay For Client lands in the payee deposit', async () => {
    const buyer = await verifiedMember();
    await fund(buyer, '9000');
    await deposit(buyer, '30000');
    let s = await summary(buyer);
    expect([s.availableBalanceMinor, s.depositBalanceMinor, s.spendableMinor]).toEqual(['9000', '30000', '39000']);

    // A 38,000 voucher takes all 30,000 of the deposit and 8,000 of the balance.
    expect((await buyer.client.post<Body>('/api/vouchers/buy', { amount: '38000', quantity: 1 }, key())).status).toBe(201);
    s = await summary(buyer);
    expect([s.availableBalanceMinor, s.depositBalanceMinor]).toEqual(['1000', '0']);
    const tooMuch = await buyer.client.post<Body>('/api/vouchers/buy', { amount: FEE, quantity: 1 }, key());
    expect(tooMuch.body.error?.code).toBe('insufficient_funds');

    const payee = await verifiedMember();
    await activate(payee);
    const paid = await buyer.client.post<Body>('/api/client-payments', { recipient: payee.input.username, amount: '1000' }, key());
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const p = await summary(payee);
    expect([p.availableBalanceMinor, p.depositBalanceMinor]).toEqual(['0', '1000']);
    expect((await summary(buyer)).spendableMinor).toBe('0');
    // The statement labels each row with the balance it touched.
    const statement = (await buyer.client.get<Body>('/api/wallet/transactions?limit=20')).body.transactions;
    expect(statement.filter((t: Body) => t.balance === 'deposit').map((t: Body) => t.amountMinor)).toEqual(['-30000', '30000']);
  });
});

describe('payment emails', () => {
  it('tells finance staff about a new payment and withdrawal, and the member when they cancel a payment claim', async () => {
    const financeEmails = (await app.owner.query<{ email: string }>(
      `SELECT DISTINCT u.email FROM users u JOIN user_roles r ON r.user_id = u.id WHERE r.role IN ('finance', 'admin') AND u.username NOT LIKE 'zx\_%'`,
    )).rows.map(r => r.email);
    const staffMails = async (prefix: string) => (await Promise.all(financeEmails.map(e => app.outbox(e)))).flat().filter(m => m.subject?.startsWith(prefix));

    const member = await verifiedMember();
    const claimed = await claim(member);
    expect(claimed.status).toBe(201);
    const ref = claimed.body.deposit.reference as string;
    const alerts = await staffMails(`Pexerearn staff: new activation payment ${ref} to check`);
    expect(alerts).toHaveLength(financeEmails.length);
    expect(alerts[0]!.body).toContain(`/admin/deposits.html?id=${claimed.body.deposit.id}`);
    expect(alerts[0]!.body).toContain(`@${member.input.username} (Uganda)`);

    expect((await member.client.post<Body>(`/api/payments/deposits/${claimed.body.deposit.id}/cancel`, {})).status).toBe(200);
    expect((await app.outbox(member.input.email)).map(m => m.subject)).toContain(`Pexerearn: Activation payment ${ref} cancelled`);

    await fund(member, '50000');
    const w = await member.client.post<Body>('/api/payments/withdrawals', { source: 'main', amount: '20000' }, key());
    expect(w.status, JSON.stringify(w.body)).toBe(201);
    expect(await staffMails(`Pexerearn staff: withdrawal ${w.body.withdrawal.reference} to approve`)).toHaveLength(financeEmails.length);
    expect((await app.outbox(member.input.email)).map(m => m.subject)).toContain(`Pexerearn: Withdrawal ${w.body.withdrawal.reference} requested`);
  });
});
