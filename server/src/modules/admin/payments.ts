import { Router, type Request } from 'express';
import { z } from 'zod';
import { maybeOne, one, rows } from '../../db/sql.js';
import { withTransaction } from '../../db/tx.js';
import { parse } from '../../http/validate.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import type { Services } from '../../services.js';
import { audit } from '../audit/audit.js';
import { requireStaff } from '../auth/middleware.js';
import { idempotent, moneyTx } from '../ledger/idempotency.js';
import { flagActive, listChannels, PAGE, setFlag } from '../payments/common.js';
import { confirmDeposit, DEPOSIT_SELECT, depositView, rejectDeposit, type DepositRow } from '../payments/deposits.js';
import { addMessage, findIssue, ISSUE_SELECT, issueView, messagesOf, setIssueStatus, type IssueRow } from '../payments/issues.js';
import { buildReport, runReconciliation } from '../payments/reconciliation.js';
import { AmountInput, amountToMinor } from '../payments/routes.js';
import { decideTreasury, listTreasury, requestTreasury, TREASURY_KINDS } from '../payments/treasury.js';
import { staffWithdrawalAction, WITHDRAWAL_SELECT, withdrawalView, type StaffAction, type WithdrawalRow } from '../payments/withdrawals.js';
import { getWalletSummary } from '../wallet/service.js';

// Staff payments console: live overview, deposit and withdrawal queues, member issues, the balance check,
// the ledger explorer, channels, pause switches, alerts and treasury. Viewing needs support, finance or
// compliance; moving money needs finance (admin for large or new-account withdrawals and for treasury
// approvals). Every change writes the audit log in the same transaction.

const VIEW = ['support', 'finance', 'compliance'] as const;
const Uuid = z.uuid();
const ListQuery = z.object({
  status: z.string().trim().max(20).optional(),
  q: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
const Note = z.string().trim().max(500);
const ConfirmBody = z.strictObject({ amount: AmountInput, note: Note.optional() });
const RejectBody = z.strictObject({ reason: z.string().trim().min(5, { error: 'Give the member a reason.' }).max(500) });
const WithdrawalBody = z.strictObject({ note: Note.optional(), payoutTxnId: z.string().trim().max(60).optional() });
const IssueStatusBody = z.strictObject({ status: z.enum(['open', 'in_progress', 'resolved']), resolution: z.string().trim().max(1000).optional() });
const MessageBody = z.strictObject({ body: z.string().trim().min(1).max(2000) });
const FlagBody = z.strictObject({ key: z.enum(['deposits_paused', 'withdrawals_paused']), currency: z.string().length(3).toUpperCase(), active: z.boolean(), reason: z.string().trim().min(5).max(500) });
const AlertBody = z.strictObject({ note: Note.optional() });
const SnapshotBody = z.strictObject({ channel: z.string().trim().max(40), balance: AmountInput, note: z.string().trim().max(300).optional() });
const ChannelBody = z.strictObject({
  code: z.string().trim().regex(/^[a-z0-9_]{2,40}$/, { error: 'Use lower-case letters, digits and underscores.' }),
  name: z.string().trim().min(2).max(60),
  country: z.string().trim().length(2),
  accountName: z.string().trim().min(2).max(80),
  accountNumber: z.string().trim().min(3).max(40),
  instructions: z.string().trim().max(600).optional(),
  depositsEnabled: z.boolean().default(true),
  payoutsEnabled: z.boolean().default(true),
});
const ChannelPatch = ChannelBody.omit({ code: true, country: true }).partial().strict();
const TreasuryBody = z.strictObject({
  kind: z.enum(TREASURY_KINDS),
  currency: z.string().length(3),
  amount: AmountInput,
  channel: z.string().trim().max(40).optional(),
  toChannel: z.string().trim().max(40).optional(),
  source: z.string().trim().max(40).optional(),
  budget: z.string().trim().max(40).optional(),
  externalRef: z.string().trim().max(60).optional(),
  note: z.string().trim().min(5, { error: 'Say what this is for.' }).max(500),
});
const DecisionBody = z.strictObject({ approve: z.boolean(), note: Note.optional() });

function uuid(value: unknown): string {
  const id = Uuid.safeParse(value);
  if (!id.success) throw notFound();
  return id.data;
}

const like = (q: string | undefined) => (q ? `%${q.replace(/[%_\\]/g, '\\$&')}%` : null);

export function paymentsAdminRouter(services: Services): Router {
  const { pool } = services;
  const router = Router();
  const staff = (req: Request) => req.auth!.userId;

  // Live overview, polled by the dashboard every few seconds.
  router.get('/overview', requireStaff(...VIEW), async (_req, res) => {
    const [counts, events, alerts, flags, lastRun, currencies] = await Promise.all([
      one<Record<string, string>>(
        pool,
        `SELECT
           (SELECT count(*) FROM deposits WHERE status = 'pending') AS deposits_pending,
           (SELECT coalesce(sum(claimed_amount_minor), 0) FROM deposits WHERE status = 'pending' AND currency_code = 'UGX') AS deposits_pending_ugx,
           (SELECT count(*) FROM deposits WHERE status = 'confirmed' AND reviewed_at > date_trunc('day', now())) AS deposits_confirmed_today,
           (SELECT coalesce(sum(credited_amount_minor), 0) FROM deposits WHERE status = 'confirmed' AND reviewed_at > date_trunc('day', now()) AND currency_code = 'UGX') AS deposits_confirmed_today_ugx,
           (SELECT count(*) FROM deposits WHERE status = 'rejected' AND reviewed_at > date_trunc('day', now())) AS deposits_rejected_today,
           (SELECT count(*) FROM withdrawals WHERE status = 'requested') AS withdrawals_requested,
           (SELECT count(*) FROM withdrawals WHERE status = 'requested' AND needs_two_people) AS withdrawals_need_admin,
           (SELECT count(*) FROM withdrawals WHERE status = 'approved') AS withdrawals_approved,
           (SELECT count(*) FROM withdrawals WHERE status = 'processing') AS withdrawals_processing,
           (SELECT coalesce(sum(amount_minor), 0) FROM withdrawals WHERE status IN ('requested', 'approved', 'processing') AND currency_code = 'UGX') AS withdrawals_open_ugx,
           (SELECT count(*) FROM withdrawals WHERE status = 'paid' AND paid_at > date_trunc('day', now())) AS withdrawals_paid_today,
           (SELECT coalesce(sum(amount_minor), 0) FROM withdrawals WHERE status = 'paid' AND paid_at > date_trunc('day', now()) AND currency_code = 'UGX') AS withdrawals_paid_today_ugx,
           (SELECT count(*) FROM payment_issues WHERE status <> 'resolved') AS issues_open,
           (SELECT count(*) FROM alerts WHERE status = 'open') AS alerts_open,
           (SELECT count(*) FROM treasury_requests WHERE status = 'pending') AS treasury_pending,
           (SELECT count(*) FROM users WHERE created_at > date_trunc('day', now())) AS members_today,
           (SELECT count(*) FROM memberships WHERE activated_at > date_trunc('day', now())) AS memberships_today`,
      ),
      rows<{ id: string; subject_type: string; from_status: string | null; to_status: string; note: string | null; created_at: Date; member: string; actor: string | null; reference: string | null; amount_minor: string | null; currency_code: string | null; subject_public_id: string | null }>(
        pool,
        `SELECT e.id, e.subject_type, e.from_status, e.to_status, e.note, e.created_at, u.username AS member, a.username AS actor,
                coalesce(d.reference, w.reference) AS reference, coalesce(d.credited_amount_minor, d.claimed_amount_minor, w.amount_minor)::text AS amount_minor,
                coalesce(d.currency_code, w.currency_code) AS currency_code, coalesce(d.public_id, w.public_id)::text AS subject_public_id
         FROM payment_events e JOIN users u ON u.id = e.user_id LEFT JOIN users a ON a.id = e.actor_user_id
         LEFT JOIN deposits d ON e.subject_type = 'deposit' AND d.id = e.subject_id
         LEFT JOIN withdrawals w ON e.subject_type = 'withdrawal' AND w.id = e.subject_id
         ORDER BY e.id DESC LIMIT 20`,
      ),
      rows(pool, `SELECT id, kind, severity, currency_code, message, occurrences, last_seen_at, status FROM alerts WHERE status <> 'resolved' ORDER BY (severity = 'critical') DESC, last_seen_at DESC LIMIT 10`),
      rows(pool, 'SELECT key, currency_code, active, automatic, reason, changed_at FROM system_flags WHERE active ORDER BY key'),
      maybeOne<{ id: string; ok: boolean; created_at: Date }>(pool, 'SELECT id, ok, created_at FROM reconciliation_runs ORDER BY id DESC LIMIT 1'),
      buildReport(pool),
    ]);
    res.json({
      serverTime: new Date().toISOString(),
      counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, String(v)])),
      events: events.map(e => ({
        id: e.id, type: e.subject_type, from: e.from_status, to: e.to_status, note: e.note, at: e.created_at, member: e.member, actor: e.actor,
        reference: e.reference, amountMinor: e.amount_minor, currency: e.currency_code, subjectId: e.subject_public_id,
      })),
      alerts,
      flags,
      lastReconciliation: lastRun,
      balances: currencies.currencies.map(c => ({
        currency: c.currency, ok: c.ok, liabilitiesMinor: c.liabilitiesMinor, fundsHeldMinor: c.fundsHeldMinor, coverageMinor: c.coverageMinor,
        unverifiedChannels: c.unverifiedChannels, platformRevenueMinor: c.system.platform_revenue, feesMinor: c.system.fees,
      })),
    });
  });

  // ---- Deposits ----
  router.get('/deposits', requireStaff(...VIEW), async (req, res) => {
    const q = parse(ListQuery, req.query);
    const list = await rows<DepositRow & { username: string; same_sender_members: string; same_txn_claims: string }>(
      pool,
      `SELECT x.*, u.username,
              (SELECT count(DISTINCT o.user_id) FROM deposits o WHERE o.sender_phone = x.sender_phone AND o.user_id <> x.user_id) AS same_sender_members,
              (SELECT count(*) FROM deposits o WHERE o.provider_txn_id = x.provider_txn_id AND o.id <> x.id) AS same_txn_claims
       FROM (${DEPOSIT_SELECT}) x JOIN users u ON u.id = x.user_id
       WHERE ($1::text IS NULL OR x.status = $1)
         AND ($2::text IS NULL OR x.reference ILIKE $2 OR x.provider_txn_id ILIKE $2 OR x.sender_phone LIKE $2 OR u.username ILIKE $2)
       ORDER BY CASE WHEN x.status = 'pending' THEN 0 ELSE 1 END, CASE WHEN x.status = 'pending' THEN x.id END ASC, x.id DESC
       LIMIT $3 OFFSET $4`,
      [q.status || null, like(q.q), PAGE + 1, (q.page - 1) * PAGE],
    );
    res.json({
      page: q.page, hasMore: list.length > PAGE,
      deposits: list.slice(0, PAGE).map(d => ({
        ...depositView(d), member: d.username, warnings: { sameSenderOtherMembers: Number(d.same_sender_members), sameTxnOtherClaims: Number(d.same_txn_claims) },
      })),
    });
  });

  router.get('/deposits/:id', requireStaff(...VIEW), async (req, res) => {
    const d = await maybeOne<DepositRow>(pool, `${DEPOSIT_SELECT} WHERE d.public_id = $1`, [uuid(req.params.id)]);
    if (!d) throw notFound();
    const [member, events, related, issues, summary] = await Promise.all([
      memberCard(Number(d.user_id)),
      eventsOf('deposit', d.id),
      rows<DepositRow & { username: string }>(
        pool,
        `SELECT x.*, u.username FROM (${DEPOSIT_SELECT}) x JOIN users u ON u.id = x.user_id
         WHERE x.id <> $1 AND (x.provider_txn_id = $2 OR x.sender_phone = $3) ORDER BY x.id DESC LIMIT 20`,
        [d.id, d.provider_txn_id, d.sender_phone],
      ),
      rows<IssueRow>(pool, `${ISSUE_SELECT} WHERE i.deposit_id = $1 ORDER BY i.id DESC`, [d.id]),
      getWalletSummary(pool, Number(d.user_id)),
    ]);
    res.json({
      deposit: depositView(d), member: { ...member, balances: summary }, events,
      related: related.map(r => ({ ...depositView(r), member: r.username })), issues: issues.map(issueView),
    });
  });

  router.post('/deposits/:id/confirm', requireStaff('finance'), async (req, res) => {
    const id = uuid(req.params.id);
    const body = parse(ConfirmBody, req.body);
    const result = await idempotent(pool, req, `admin.deposit.confirm.${id}`, async db => {
      const currency = (await one<{ currency_code: string }>(db, 'SELECT currency_code FROM deposits WHERE public_id = $1', [id])).currency_code;
      const amount = await amountToMinor(db, currency, body.amount);
      const { before, after } = await confirmDeposit(db, staff(req), id, amount, body.note ?? null);
      await audit(db, req, { action: 'deposit.confirmed', targetType: 'deposit', targetId: after.reference, before, after, reason: body.note });
      return { status: 200, body: { deposit: after } };
    });
    res.status(result.status).json(result.body);
  });

  router.post('/deposits/:id/reject', requireStaff('finance'), async (req, res) => {
    const id = uuid(req.params.id);
    const { reason } = parse(RejectBody, req.body);
    const deposit = await moneyTx(pool, async db => {
      const { before, after } = await rejectDeposit(db, staff(req), id, reason);
      await audit(db, req, { action: 'deposit.rejected', targetType: 'deposit', targetId: after.reference, before, after, reason });
      return after;
    });
    res.json({ deposit });
  });

  // ---- Withdrawals ----
  router.get('/withdrawals', requireStaff(...VIEW), async (req, res) => {
    const q = parse(ListQuery, req.query);
    const list = await rows<WithdrawalRow & { username: string; approver: string | null; processor: string | null }>(
      pool,
      `SELECT x.*, u.username, ap.username AS approver, pr.username AS processor
       FROM (${WITHDRAWAL_SELECT}) x JOIN users u ON u.id = x.user_id
       LEFT JOIN users ap ON ap.id = x.approved_by LEFT JOIN users pr ON pr.id = x.processing_by
       WHERE ($1::text IS NULL OR x.status = $1 OR ($1 = 'open' AND x.status IN ('requested', 'approved', 'processing')))
         AND ($2::text IS NULL OR x.reference ILIKE $2 OR x.payout_phone LIKE $2 OR u.username ILIKE $2 OR x.payout_txn_id ILIKE $2)
       ORDER BY CASE WHEN x.status IN ('requested', 'approved', 'processing') THEN 0 ELSE 1 END,
                CASE WHEN x.status IN ('requested', 'approved', 'processing') THEN x.id END ASC, x.id DESC
       LIMIT $3 OFFSET $4`,
      [q.status || null, like(q.q), PAGE + 1, (q.page - 1) * PAGE],
    );
    res.json({
      page: q.page, hasMore: list.length > PAGE,
      withdrawals: list.slice(0, PAGE).map(w => ({ ...withdrawalView(w), member: w.username, approvedBy: w.approver, processingBy: w.processor })),
    });
  });

  router.get('/withdrawals/:id', requireStaff(...VIEW), async (req, res) => {
    const w = await maybeOne<WithdrawalRow & { approver: string | null; processor: string | null; payer: string | null; closer: string | null }>(
      pool,
      `SELECT x.*, ap.username AS approver, pr.username AS processor, pa.username AS payer, cl.username AS closer
       FROM (${WITHDRAWAL_SELECT}) x LEFT JOIN users ap ON ap.id = x.approved_by LEFT JOIN users pr ON pr.id = x.processing_by
       LEFT JOIN users pa ON pa.id = x.paid_by LEFT JOIN users cl ON cl.id = x.closed_by WHERE x.public_id = $1`,
      [uuid(req.params.id)],
    );
    if (!w) throw notFound();
    const [member, events, issues, summary, recent] = await Promise.all([
      memberCard(Number(w.user_id)),
      eventsOf('withdrawal', w.id),
      rows<IssueRow>(pool, `${ISSUE_SELECT} WHERE i.withdrawal_id = $1 ORDER BY i.id DESC`, [w.id]),
      getWalletSummary(pool, Number(w.user_id)),
      one<{ deposits: string; withdrawals: string }>(
        pool,
        `SELECT (SELECT coalesce(sum(credited_amount_minor), 0) FROM deposits WHERE user_id = $1 AND status = 'confirmed')::text AS deposits,
                (SELECT coalesce(sum(amount_minor), 0) FROM withdrawals WHERE user_id = $1 AND status = 'paid')::text AS withdrawals`,
        [w.user_id],
      ),
    ]);
    res.json({
      withdrawal: { ...withdrawalView(w), approvedBy: w.approver, processingBy: w.processor, paidBy: w.payer, closedBy: w.closer },
      member: { ...member, balances: summary, lifetime: { depositedMinor: recent.deposits, withdrawnMinor: recent.withdrawals } },
      events, issues: issues.map(issueView),
      you: { canApproveLarge: req.auth!.roles.includes('admin'), isApprover: String(staff(req)) === w.approved_by },
    });
  });

  for (const action of ['approve', 'start', 'paid', 'fail', 'cancel'] as const satisfies readonly StaffAction[]) {
    router.post(`/withdrawals/:id/${action}`, requireStaff('finance'), async (req, res) => {
      const id = uuid(req.params.id);
      const body = parse(WithdrawalBody, req.body);
      const result = await idempotent(pool, req, `admin.withdrawal.${action}.${id}`, async db => {
        const { before, after } = await staffWithdrawalAction(db, id, { action, staffId: staff(req), roles: req.auth!.roles, note: body.note ?? null, payoutTxnId: body.payoutTxnId });
        await audit(db, req, { action: `withdrawal.${action}`, targetType: 'withdrawal', targetId: after.reference, before, after, reason: body.note });
        return { status: 200, body: { withdrawal: after } };
      });
      res.status(result.status).json(result.body);
    });
  }

  // ---- Issues ----
  router.get('/issues', requireStaff(...VIEW), async (req, res) => {
    const q = parse(ListQuery, req.query);
    const list = await rows<IssueRow>(
      pool,
      `${ISSUE_SELECT}
       WHERE ($1::text IS NULL OR i.status = $1 OR ($1 = 'unresolved' AND i.status <> 'resolved'))
         AND ($2::text IS NULL OR u.username ILIKE $2 OR d.reference ILIKE $2 OR w.reference ILIKE $2)
       ORDER BY CASE WHEN i.status = 'resolved' THEN 1 ELSE 0 END, i.updated_at DESC LIMIT $3 OFFSET $4`,
      [q.status || null, like(q.q), PAGE + 1, (q.page - 1) * PAGE],
    );
    res.json({ page: q.page, hasMore: list.length > PAGE, issues: list.slice(0, PAGE).map(issueView) });
  });

  router.get('/issues/:id', requireStaff(...VIEW), async (req, res) => {
    const issue = await findIssue(pool, uuid(req.params.id));
    const [messages, member] = await Promise.all([messagesOf(pool, issue.id), memberCard(Number(issue.user_id))]);
    res.json({ issue: issueView(issue), messages, member });
  });

  router.post('/issues/:id/messages', requireStaff(...VIEW), async (req, res) => {
    const { body } = parse(MessageBody, req.body);
    const id = uuid(req.params.id);
    await withTransaction(pool, async db => {
      const issue = await findIssue(db, id);
      await addMessage(db, issue, staff(req), true, body);
      await audit(db, req, { action: 'issue.replied', targetType: 'payment_issue', targetId: id });
    });
    res.status(201).json({ ok: true });
  });

  router.post('/issues/:id/status', requireStaff(...VIEW), async (req, res) => {
    const input = parse(IssueStatusBody, req.body);
    const id = uuid(req.params.id);
    await withTransaction(pool, async db => {
      const issue = await findIssue(db, id);
      await setIssueStatus(db, issue, staff(req), input.status, input.resolution ?? null);
      await audit(db, req, { action: 'issue.status_changed', targetType: 'payment_issue', targetId: id, before: { status: issue.status }, after: { status: input.status }, reason: input.resolution });
    });
    res.json({ ok: true });
  });

  // ---- Balance check, alerts and pause switches ----
  router.get('/balances', requireStaff('finance', 'compliance'), async (_req, res) => {
    const [report, runs, flags] = await Promise.all([
      buildReport(pool),
      rows(pool, 'SELECT id, ok, created_at, triggered_by FROM reconciliation_runs ORDER BY id DESC LIMIT 10'),
      rows(pool, 'SELECT key, currency_code, active, automatic, reason, changed_at FROM system_flags ORDER BY currency_code, key'),
    ]);
    res.json({ report, runs, flags });
  });

  router.post('/reconciliation/run', requireStaff('finance', 'compliance'), async (req, res) => {
    const { id, report } = await runReconciliation(pool, staff(req));
    await audit(pool, req, { action: 'reconciliation.run', targetType: 'reconciliation_run', targetId: String(id), after: { ok: report.ok } });
    res.json({ id, report });
  });

  router.post('/float-snapshots', requireStaff('finance'), async (req, res) => {
    const body = parse(SnapshotBody, req.body);
    await withTransaction(pool, async db => {
      const channel = await maybeOne<{ id: string; currency_code: string }>(db, 'SELECT id, currency_code FROM payment_channels WHERE code = $1', [body.channel]);
      if (!channel) throw notFound('payments.channel_not_found', 'Unknown channel.');
      const balance = await amountToMinorAllowZero(db, channel.currency_code, body.balance);
      await db.query('INSERT INTO float_snapshots (channel_id, balance_minor, currency_code, note, recorded_by) VALUES ($1, $2, $3, $4, $5)', [channel.id, balance.toString(), channel.currency_code, body.note ?? null, staff(req)]);
      await audit(db, req, { action: 'float.recorded', targetType: 'payment_channel', targetId: body.channel, after: { balanceMinor: balance.toString() }, reason: body.note });
    });
    res.status(201).json({ ok: true });
  });

  router.post('/flags', requireStaff('finance'), async (req, res) => {
    const body = parse(FlagBody, req.body);
    await withTransaction(pool, async db => {
      const before = await flagActive(db, body.key, body.currency);
      if (!body.active && before.active) {
        if (!req.auth!.roles.includes('admin')) throw forbidden('flags.admin_required', 'Only an admin can resume payments.');
        if (body.key === 'withdrawals_paused') {
          const report = await buildReport(db);
          if (report.currencies.some(c => c.currency === body.currency && !c.ok)) {
            throw conflict('flags.check_failing', 'The balance check still fails for this currency. Fix the findings first.');
          }
        }
      }
      await setFlag(db, body.key, body.currency, body.active, body.reason, staff(req), false);
      await audit(db, req, { action: body.active ? 'payments.paused' : 'payments.resumed', targetType: 'system_flag', targetId: `${body.key}:${body.currency}`, before, after: { active: body.active }, reason: body.reason });
    });
    res.json({ ok: true });
  });

  router.get('/alerts', requireStaff(...VIEW), async (req, res) => {
    const { status } = parse(z.object({ status: z.enum(['open', 'acknowledged', 'resolved', 'unresolved']).default('unresolved') }), req.query);
    res.json({
      alerts: await rows(
        pool,
        `SELECT id, kind, severity, currency_code, message, details, status, occurrences, first_seen_at, last_seen_at, resolved_at, resolution_note
         FROM alerts WHERE ($1 = 'unresolved' AND status <> 'resolved') OR status = $1 ORDER BY last_seen_at DESC LIMIT 100`,
        [status],
      ),
    });
  });

  for (const action of ['acknowledge', 'resolve'] as const) {
    router.post(`/alerts/:id/${action}`, requireStaff('finance', 'compliance'), async (req, res) => {
      const id = parse(z.coerce.number().int().positive(), req.params.id);
      const { note } = parse(AlertBody, req.body);
      await withTransaction(pool, async db => {
        const changed = action === 'acknowledge'
          ? await db.query(`UPDATE alerts SET status = 'acknowledged', acknowledged_by = $2 WHERE id = $1 AND status = 'open'`, [id, staff(req)])
          : await db.query(`UPDATE alerts SET status = 'resolved', resolved_by = $2, resolved_at = now(), resolution_note = $3 WHERE id = $1 AND status <> 'resolved'`, [id, staff(req), note ?? null]);
        if (changed.rowCount !== 1) throw conflict('alert.state', 'This alert has already changed. Refresh the page.');
        await audit(db, req, { action: `alert.${action}d`, targetType: 'alert', targetId: String(id), reason: note });
      });
      res.json({ ok: true });
    });
  }

  // ---- Ledger explorer (read-only) ----
  router.get('/ledger', requireStaff('finance', 'compliance'), async (req, res) => {
    const q = parse(ListQuery, req.query);
    const txns = await rows<{ id: string; kind: string; memo: string; ref_type: string | null; ref_id: string | null; created_at: Date; actor: string | null }>(
      pool,
      `SELECT t.id, t.kind, t.memo, t.ref_type, t.ref_id, t.created_at, a.username AS actor
       FROM ledger_transactions t LEFT JOIN users a ON a.id = t.actor_user_id
       WHERE ($1::text IS NULL OR t.kind = $1)
         AND ($2::text IS NULL OR t.ref_id ILIKE $2 OR t.memo ILIKE $2 OR EXISTS (
           SELECT 1 FROM ledger_entries e JOIN accounts ac ON ac.id = e.account_id JOIN users u ON u.id = ac.user_id
           WHERE e.transaction_id = t.id AND u.username ILIKE $2))
       ORDER BY t.id DESC LIMIT $3 OFFSET $4`,
      [q.status || null, like(q.q), PAGE + 1, (q.page - 1) * PAGE],
    );
    const page = txns.slice(0, PAGE);
    const entries = await rows<{ transaction_id: string; side: string; amount_minor: string; currency_code: string; balance_after_minor: string; kind: string; module: string | null; username: string | null; channel: string | null }>(
      pool,
      `SELECT e.transaction_id, e.side, e.amount_minor, e.currency_code, e.balance_after_minor, a.kind, a.module, u.username, c.name AS channel
       FROM ledger_entries e JOIN accounts a ON a.id = e.account_id LEFT JOIN users u ON u.id = a.user_id LEFT JOIN payment_channels c ON c.id = a.channel_id
       WHERE e.transaction_id = ANY($1::bigint[]) ORDER BY e.id`,
      [page.map(t => t.id)],
    );
    res.json({
      page: q.page, hasMore: txns.length > PAGE,
      transactions: page.map(t => ({
        id: t.id, kind: t.kind, memo: t.memo, refType: t.ref_type, refId: t.ref_id, createdAt: t.created_at, actor: t.actor,
        entries: entries.filter(e => e.transaction_id === t.id).map(e => ({
          side: e.side, amountMinor: e.amount_minor, currency: e.currency_code, balanceAfterMinor: e.balance_after_minor,
          account: e.username ? `${e.kind === 'member_task' ? `${e.module} earnings` : e.kind === 'member_withdrawal_hold' ? 'withdrawal hold' : 'main balance'} @${e.username}` : e.channel ? `cash on ${e.channel}` : e.kind,
        })),
      })),
    });
  });

  // ---- Payment channels ----
  router.get('/channels', requireStaff(...VIEW), async (_req, res) => {
    res.json({ channels: await listChannels(pool) });
  });

  router.post('/channels', requireStaff('admin'), async (req, res) => {
    const body = parse(ChannelBody, req.body);
    await withTransaction(pool, async db => {
      const country = await maybeOne<{ currency_code: string }>(db, 'SELECT currency_code FROM countries WHERE code = $1', [body.country.toUpperCase()]);
      if (!country) throw badRequest('validation_failed', 'Unknown country.', { country: ['Unknown country.'] });
      if (await maybeOne(db, 'SELECT 1 FROM payment_channels WHERE code = $1', [body.code])) throw conflict('channel.exists', 'A channel with this code already exists.');
      await db.query(
        `INSERT INTO payment_channels (code, name, country_code, currency_code, account_name, account_number, instructions, deposits_enabled, payouts_enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [body.code, body.name, body.country.toUpperCase(), country.currency_code, body.accountName, body.accountNumber, body.instructions ?? null, body.depositsEnabled, body.payoutsEnabled],
      );
      await audit(db, req, { action: 'channel.created', targetType: 'payment_channel', targetId: body.code, after: body });
    });
    res.status(201).json({ ok: true });
  });

  router.patch('/channels/:code', requireStaff('admin'), async (req, res) => {
    const body = parse(ChannelPatch, req.body);
    const code = String(req.params.code);
    await withTransaction(pool, async db => {
      const before = await maybeOne<Record<string, unknown>>(db, 'SELECT name, account_name, account_number, instructions, deposits_enabled, payouts_enabled FROM payment_channels WHERE code = $1 FOR UPDATE', [code]);
      if (!before) throw notFound();
      await db.query(
        `UPDATE payment_channels SET name = coalesce($2, name), account_name = coalesce($3, account_name), account_number = coalesce($4, account_number),
           instructions = coalesce($5, instructions), deposits_enabled = coalesce($6, deposits_enabled), payouts_enabled = coalesce($7, payouts_enabled)
         WHERE code = $1`,
        [code, body.name ?? null, body.accountName ?? null, body.accountNumber ?? null, body.instructions ?? null, body.depositsEnabled ?? null, body.payoutsEnabled ?? null],
      );
      await audit(db, req, { action: 'channel.updated', targetType: 'payment_channel', targetId: code, before, after: body });
    });
    res.json({ ok: true });
  });

  // ---- Treasury (maker-checker) ----
  router.get('/treasury', requireStaff('finance', 'compliance'), async (_req, res) => {
    res.json({ requests: await listTreasury(pool) });
  });

  router.post('/treasury', requireStaff('finance'), async (req, res) => {
    const body = parse(TreasuryBody, req.body);
    const id = await withTransaction(pool, async db => {
      const amountMinor = await amountToMinor(db, body.currency.toUpperCase(), body.amount);
      const created = await requestTreasury(db, staff(req), { ...body, currency: body.currency.toUpperCase(), amountMinor });
      await audit(db, req, { action: 'treasury.requested', targetType: 'treasury_request', targetId: created, after: { ...body }, reason: body.note });
      return created;
    });
    res.status(201).json({ id });
  });

  router.post('/treasury/:id/decide', requireStaff('admin'), async (req, res) => {
    const id = uuid(req.params.id);
    const body = parse(DecisionBody, req.body);
    const result = await idempotent(pool, req, `admin.treasury.decide.${id}`, async db => {
      const decided = await decideTreasury(db, staff(req), id, body.approve, body.note ?? null);
      await audit(db, req, { action: body.approve ? 'treasury.approved' : 'treasury.rejected', targetType: 'treasury_request', targetId: id, after: decided, reason: body.note });
      return { status: 200, body: { request: decided } };
    });
    res.status(result.status).json(result.body);
  });

  // Small member card shown next to every payment: who they are and whether anything looks off.
  async function memberCard(userId: number) {
    const m = await one<{ public_id: string; username: string; phone_e164: string | null; country_code: string; status: string; created_at: Date; phone_verified: boolean; open_flags: string; membership: boolean; withdrawals_locked_until: Date | null }>(
      pool,
      `SELECT u.public_id, u.username, u.phone_e164, u.country_code, u.status, u.created_at, u.phone_verified_at IS NOT NULL AS phone_verified, u.withdrawals_locked_until,
              (SELECT count(*) FROM fraud_flags f WHERE f.user_id = u.id AND f.status = 'open') AS open_flags,
              EXISTS (SELECT 1 FROM memberships ms WHERE ms.user_id = u.id) AS membership
       FROM users u WHERE u.id = $1`,
      [userId],
    );
    return {
      id: m.public_id, username: m.username, phone: m.phone_e164, country: m.country_code, status: m.status, joinedAt: m.created_at,
      phoneVerified: m.phone_verified, openFlags: Number(m.open_flags), membershipActive: m.membership, withdrawalsLockedUntil: m.withdrawals_locked_until,
    };
  }

  async function eventsOf(type: 'deposit' | 'withdrawal', subjectId: string) {
    const list = await rows<{ id: string; from_status: string | null; to_status: string; note: string | null; created_at: Date; actor: string | null }>(
      pool,
      `SELECT e.id, e.from_status, e.to_status, e.note, e.created_at, a.username AS actor FROM payment_events e LEFT JOIN users a ON a.id = e.actor_user_id
       WHERE e.subject_type = $1 AND e.subject_id = $2 ORDER BY e.id`,
      [type, subjectId],
    );
    return list.map(e => ({ id: e.id, from: e.from_status, to: e.to_status, note: e.note, at: e.created_at, actor: e.actor }));
  }

  return router;
}

// A statement balance may be zero.
async function amountToMinorAllowZero(db: Parameters<typeof amountToMinor>[0], currency: string, amount: string): Promise<bigint> {
  if (/^0+(\.0+)?$/.test(amount.trim())) return 0n;
  return amountToMinor(db, currency, amount, 'balance');
}
