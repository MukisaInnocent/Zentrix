import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import type { TestClient } from '../helpers/client.js';
import { createStaff, loginStaff, registerMember, type Member, type Staff } from '../helpers/factories.js';

// Manual deposits and withdrawals end to end through the HTTP API, with the staff console.
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

beforeAll(async () => {
  app = await startTestApp();
  admin = await createStaff(app, ['admin']);
  adminClient = await loginStaff(app, admin);
  admin2Client = await loginStaff(app, await createStaff(app, ['admin']));
  financeClient = await loginStaff(app, await createStaff(app, ['finance']));
  supportClient = await loginStaff(app, await createStaff(app, ['support']));
  const created = await adminClient.post('/api/admin/payments/channels', {
    code: CHANNEL, name: 'MTN Mobile Money', country: 'UG', accountName: 'ZENTRIX TEST', accountNumber: '0700 000 001',
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
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

async function claim(member: Member, amount: string, extra: Record<string, unknown> = {}) {
  return member.client.post<Body>('/api/payments/deposits', { channel: CHANNEL, amount, senderPhone: member.input.phone, providerTxnId: txnId(), ...extra }, key());
}

async function fund(member: Member, amount: string): Promise<void> {
  const res = await claim(member, amount);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const ok = await financeClient.post<Body>(`/api/admin/payments/deposits/${res.body.deposit.id}/confirm`, { amount }, key());
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
}

const summary = async (member: Member) => (await member.client.get<Body>('/api/wallet/summary')).body;

describe('manual deposits', () => {
  it('credits nothing until staff confirm, then credits exactly once', async () => {
    const member = await verifiedMember();
    expect((await member.client.post<Body>('/api/payments/deposits', { channel: CHANNEL, amount: '20000', senderPhone: member.input.phone, providerTxnId: txnId() })).body.error?.code).toBe('idempotency.missing');
    const res = await claim(member, '20000');
    expect(res.status).toBe(201);
    expect(res.body.deposit.status).toBe('pending');
    expect((await summary(member)).availableBalanceMinor).toBe('0');
    expect((await summary(member)).pendingDepositsMinor).toBe('20000');

    const headers = key();
    const first = await financeClient.post<Body>(`/api/admin/payments/deposits/${res.body.deposit.id}/confirm`, { amount: '20000' }, headers);
    const replay = await financeClient.post<Body>(`/api/admin/payments/deposits/${res.body.deposit.id}/confirm`, { amount: '20000' }, headers);
    expect(first.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    const again = await financeClient.post<Body>(`/api/admin/payments/deposits/${res.body.deposit.id}/confirm`, { amount: '20000' }, key());
    expect(again.body.error?.code).toBe('deposit.not_pending');
    expect((await summary(member)).availableBalanceMinor).toBe('20000');

    const events = await app.owner.query('SELECT from_status, to_status, actor_user_id FROM payment_events WHERE subject_type = $1 ORDER BY id', ['deposit']);
    expect(events.rows.some(e => e.from_status === 'pending' && e.to_status === 'confirmed' && e.actor_user_id !== null)).toBe(true);
    expect((await app.owner.query(`SELECT 1 FROM audit_log WHERE action = 'deposit.confirmed' AND target_id = $1`, [res.body.deposit.reference])).rowCount).toBe(1);
  });

  it('confirms only once when two staff click at the same time', async () => {
    const member = await verifiedMember();
    const res = await claim(member, '7000');
    const both = await Promise.all([
      financeClient.post<Body>(`/api/admin/payments/deposits/${res.body.deposit.id}/confirm`, { amount: '7000' }, key()),
      adminClient.post<Body>(`/api/admin/payments/deposits/${res.body.deposit.id}/confirm`, { amount: '7000' }, key()),
    ]);
    expect(both.map(r => r.status).sort()).toEqual([200, 409]);
    expect((await summary(member)).availableBalanceMinor).toBe('7000');
  });

  it('credits the amount actually received, with a note when it differs', async () => {
    const member = await verifiedMember();
    const res = await claim(member, '10000');
    const noNote = await financeClient.post<Body>(`/api/admin/payments/deposits/${res.body.deposit.id}/confirm`, { amount: '9500' }, key());
    expect(noNote.body.error?.fields?.note).toBeDefined();
    const ok = await financeClient.post<Body>(`/api/admin/payments/deposits/${res.body.deposit.id}/confirm`, { amount: '9500', note: 'Statement shows 9,500 received' }, key());
    expect(ok.body.deposit.creditedAmountMinor).toBe('9500');
    expect((await summary(member)).availableBalanceMinor).toBe('9500');
  });

  it('blocks a reused transaction ID, and lets staff reject a claim with a reason', async () => {
    const a = await verifiedMember();
    const b = await verifiedMember();
    const id = txnId();
    expect((await claim(a, '5000', { providerTxnId: id })).status).toBe(201);
    const dup = await claim(b, '5000', { providerTxnId: id.toLowerCase() });
    expect(dup.status).toBe(409);
    expect(dup.body.error?.code).toBe('deposit.duplicate_txn');

    const fake = await claim(b, '5000');
    const rejected = await financeClient.post<Body>(`/api/admin/payments/deposits/${fake.body.deposit.id}/reject`, { reason: 'No such payment on the statement' });
    expect(rejected.body.deposit.status).toBe('rejected');
    expect((await b.client.get<Body>('/api/payments/deposits')).body.deposits.find((d: Body) => d.id === fake.body.deposit.id).reviewNote).toBe('No such payment on the statement');
  });

  it('keeps money actions away from members, support staff and the claimant', async () => {
    const member = await verifiedMember();
    const res = await claim(member, '3000');
    expect((await member.client.post<Body>(`/api/admin/payments/deposits/${res.body.deposit.id}/confirm`, { amount: '3000' }, key())).status).toBe(403);
    expect((await supportClient.post<Body>(`/api/admin/payments/deposits/${res.body.deposit.id}/confirm`, { amount: '3000' }, key())).status).toBe(403);
    expect((await supportClient.get<Body>('/api/admin/payments/deposits?status=pending')).status).toBe(200);
    // A staff member's own deposit must be reviewed by someone else.
    const staffMember = await createStaff(app, ['finance']);
    const staffClient = await loginStaff(app, staffMember);
    await app.owner.query('UPDATE users SET phone_verified_at = now() WHERE id = $1', [staffMember.userId]);
    const phone = (await app.owner.query<{ phone_e164: string }>('SELECT phone_e164 FROM users WHERE id = $1', [staffMember.userId])).rows[0]!.phone_e164;
    const own = await staffClient.post<Body>('/api/payments/deposits', { channel: CHANNEL, amount: '1000', senderPhone: phone, providerTxnId: txnId() }, key());
    expect((await staffClient.post<Body>(`/api/admin/payments/deposits/${own.body.deposit.id}/confirm`, { amount: '1000' }, key())).body.error?.code).toBe('admin.self_action');
  });
});

describe('membership', () => {
  it('charges UGX 19,000 from the main balance to platform revenue and records a pending direct referral only', async () => {
    const grand = await verifiedMember();
    const referrer = await verifiedMember({ referralCode: grand.user.referralCode });
    const member = await verifiedMember({ referralCode: referrer.user.referralCode });
    const poor = await member.client.post<Body>('/api/wallet/membership/activate', {}, key());
    expect(poor.body.error?.code).toBe('membership.insufficient_funds');

    await fund(member, '20000');
    const act = await member.client.post<Body>('/api/wallet/membership/activate', {}, key());
    expect(act.status, JSON.stringify(act.body)).toBe(200);
    expect(act.body.feeMinor).toBe('19000');
    expect(act.body.receiptNo).toMatch(/^MB-/);
    expect(act.body.summary.availableBalanceMinor).toBe('1000');
    expect((await member.client.post<Body>('/api/wallet/membership/activate', {}, key())).body.alreadyActive).toBe(true);
    expect((await summary(member)).availableBalanceMinor).toBe('1000');

    const rewards = await app.owner.query<{ referrer: string; level: number; amount_minor: string; status: string }>(
      `SELECT u.public_id AS referrer, r.level, r.amount_minor, r.status FROM referral_rewards r JOIN users u ON u.id = r.referrer_user_id
       JOIN users m ON m.id = r.referred_user_id WHERE m.public_id = $1`,
      [member.user.id],
    );
    expect(rewards.rows).toEqual([{ referrer: referrer.user.id, level: 1, amount_minor: '1000', status: 'pending' }]);
    expect((await summary(referrer)).availableBalanceMinor).toBe('0');
    expect((await summary(grand)).availableBalanceMinor).toBe('0');
  });
});

describe('manual withdrawals', () => {
  it('holds amount plus 0.5% fee, needs an admin approval and a second person to record the payout', async () => {
    const member = await verifiedMember();
    await fund(member, '50000');
    const quote = await member.client.get<Body>('/api/payments/withdrawals/quote?amount=20000');
    expect(quote.body.quote.feeMinor).toBe('100');
    expect(quote.body.quote.needsAdminApproval).toBe(true); // new account

    const res = await member.client.post<Body>('/api/payments/withdrawals', { source: 'main', amount: '20000', channel: CHANNEL }, key());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const id = res.body.withdrawal.id;
    expect(res.body.withdrawal.payoutPhone).toBe(member.input.phone);
    let s = await summary(member);
    expect([s.availableBalanceMinor, s.reservedBalanceMinor]).toEqual(['29900', '20100']);

    expect((await financeClient.post<Body>(`/api/admin/payments/withdrawals/${id}/approve`, {}, key())).body.error?.code).toBe('withdrawal.admin_required');
    expect((await adminClient.post<Body>(`/api/admin/payments/withdrawals/${id}/approve`, {}, key())).status).toBe(200);
    expect((await adminClient.post<Body>(`/api/admin/payments/withdrawals/${id}/start`, {}, key())).body.error?.code).toBe('withdrawal.two_people');
    expect((await financeClient.post<Body>(`/api/admin/payments/withdrawals/${id}/paid`, { payoutTxnId: 'PAY1' }, key())).body.error?.code).toBe('withdrawal.wrong_state');
    expect((await financeClient.post<Body>(`/api/admin/payments/withdrawals/${id}/start`, {}, key())).status).toBe(200);
    expect((await member.client.post<Body>(`/api/payments/withdrawals/${id}/cancel`, {}, key())).body.error?.code).toBe('withdrawal.not_cancellable');
    const paid = await financeClient.post<Body>(`/api/admin/payments/withdrawals/${id}/paid`, { payoutTxnId: `PAY${txnId()}` }, key());
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.withdrawal.status).toBe('paid');
    s = await summary(member);
    expect([s.availableBalanceMinor, s.reservedBalanceMinor, s.totalWithdrawnMinor]).toEqual(['29900', '0', '20000']);
    const fees = await app.owner.query<{ balance_minor: string }>(`SELECT balance_minor FROM accounts WHERE kind = 'fees' AND currency_code = 'UGX'`);
    expect(BigInt(fees.rows[0]!.balance_minor)).toBeGreaterThanOrEqual(100n);
    await expect(app.owner.query(`UPDATE withdrawals SET status = 'requested' WHERE public_id = $1`, [id])).rejects.toSatisfy(e => (e as { code?: string }).code === 'ZX012');
  });

  it('returns the full hold when the member cancels or the payout fails', async () => {
    const member = await verifiedMember();
    await fund(member, '10000');
    const a = await member.client.post<Body>('/api/payments/withdrawals', { source: 'main', amount: '4000', channel: CHANNEL }, key());
    expect((await member.client.post<Body>(`/api/payments/withdrawals/${a.body.withdrawal.id}/cancel`, {}, key())).body.withdrawal.status).toBe('cancelled');
    expect((await summary(member)).availableBalanceMinor).toBe('10000');

    const b = await member.client.post<Body>('/api/payments/withdrawals', { source: 'main', amount: '4000', channel: CHANNEL }, key());
    await adminClient.post(`/api/admin/payments/withdrawals/${b.body.withdrawal.id}/approve`, {}, key());
    await financeClient.post(`/api/admin/payments/withdrawals/${b.body.withdrawal.id}/start`, {}, key());
    expect((await financeClient.post<Body>(`/api/admin/payments/withdrawals/${b.body.withdrawal.id}/fail`, {}, key())).body.error?.fields?.note).toBeDefined();
    const failed = await financeClient.post<Body>(`/api/admin/payments/withdrawals/${b.body.withdrawal.id}/fail`, { note: 'Number not registered for mobile money' }, key());
    expect(failed.body.withdrawal.status).toBe('failed');
    const s = await summary(member);
    expect([s.availableBalanceMinor, s.reservedBalanceMinor]).toEqual(['10000', '0']);
  });

  it('cannot overdraw with simultaneous requests, and enforces the minimum and a verified phone', async () => {
    const member = await verifiedMember();
    await fund(member, '10000');
    const results = await Promise.all(
      Array.from({ length: 4 }, () => member.client.post<Body>('/api/payments/withdrawals', { source: 'main', amount: '6000', channel: CHANNEL }, key())),
    );
    expect(results.filter(r => r.status === 201)).toHaveLength(1);
    expect((await summary(member)).availableBalanceMinor).toBe('3970');
    expect((await member.client.post<Body>('/api/payments/withdrawals', { source: 'main', amount: '500', channel: CHANNEL }, key())).body.error?.fields?.amount).toBeDefined();

    const unverified = await registerMember(app);
    expect((await unverified.client.post<Body>('/api/payments/withdrawals', { source: 'main', amount: '1000', channel: CHANNEL }, key())).body.error?.code).toBe('withdrawal.phone_unverified');
  });
});

describe('balance check, pauses and alerts', () => {
  it('pauses withdrawals when the channel statement shows less than members are owed', async () => {
    const member = await verifiedMember();
    await fund(member, '8000');
    const clean = await financeClient.post<Body>('/api/admin/payments/reconciliation/run', {});
    expect(clean.body.report.ok, JSON.stringify(clean.body.report)).toBe(true);

    expect((await financeClient.post<Body>('/api/admin/payments/float-snapshots', { channel: CHANNEL, balance: '0', note: 'Statement read' })).status).toBe(201);
    const failing = await financeClient.post<Body>('/api/admin/payments/reconciliation/run', {});
    const ugx = failing.body.report.currencies.find((c: Body) => c.currency === 'UGX');
    expect(ugx.ok).toBe(false);
    expect(ugx.findings.map((f: Body) => f.kind)).toContain('solvency');

    const blocked = await member.client.post<Body>('/api/payments/withdrawals', { source: 'main', amount: '1000', channel: CHANNEL }, key());
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
    expect((await member.client.post<Body>('/api/payments/withdrawals', { source: 'main', amount: '1000', channel: CHANNEL }, key())).status).toBe(201);
  });
});

describe('treasury and task budget', () => {
  it('needs a different admin to approve, and task rewards stop when the budget is empty', async () => {
    const member = await verifiedMember();
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
    expect((await summary(member)).taskBalancesMinor.youtube).toBe(task.rewardMinor);
    expect((await summary(member)).availableBalanceMinor).toBe('0');
    const trivia = await member.client.get<Body>('/api/tasks?module=trivia');
    expect(JSON.stringify(trivia.body)).not.toContain('"answer"');
  });
});

describe('payment issues', () => {
  it('lets a member report a problem on their own deposit and talk to staff', async () => {
    const member = await verifiedMember();
    const other = await verifiedMember();
    const res = await claim(member, '15000');
    const ref = res.body.deposit.reference;
    expect((await other.client.post<Body>('/api/payments/issues', { subjectType: 'deposit', reference: ref, category: 'not_credited', message: 'I sent this money an hour ago.' })).status).toBe(400);
    const opened = await member.client.post<Body>('/api/payments/issues', { subjectType: 'deposit', reference: ref, category: 'not_credited', message: 'I sent this money an hour ago.' });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const id = opened.body.issue.id;

    const queue = await supportClient.get<Body>('/api/admin/payments/issues?status=unresolved');
    expect(queue.body.issues.find((i: Body) => i.id === id).awaitingStaff).toBe(true);
    await supportClient.post(`/api/admin/payments/issues/${id}/messages`, { body: 'We are checking the statement now.' });
    expect((await supportClient.post<Body>(`/api/admin/payments/issues/${id}/status`, { status: 'resolved' })).body.error?.fields?.resolution).toBeDefined();
    await supportClient.post(`/api/admin/payments/issues/${id}/status`, { status: 'resolved', resolution: 'Deposit confirmed by finance.' });

    const thread = await member.client.get<Body>(`/api/payments/issues/${id}`);
    expect(thread.body.issue.status).toBe('resolved');
    expect(thread.body.messages.map((m: Body) => m.author)).toEqual([member.input.username, 'Zentrix support', 'Zentrix support']);
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
