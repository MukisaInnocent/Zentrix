import type { Pool } from '../../db/pool.js';
import type { Db } from '../../db/sql.js';
import { one, rows } from '../../db/sql.js';
import { withTransaction } from '../../db/tx.js';
import { setFlag } from './common.js';

// The balance check (rule 6 and section 5). Per currency it proves the ledger balances, that every cached
// balance equals the sum of its entries, and that what members are owed (main, task and held balances) is
// covered by the money actually held on the payment channels. Money held is the latest balance staff read off
// each channel statement; a channel with no recorded statement counts at its ledger value and is flagged as
// unverified. Solvency, drift or an unbalanced ledger pause withdrawals in that currency and raise a critical
// alert. Stuck payments raise warnings.

const STUCK = { depositPendingHours: 24, withdrawalWaitingHours: 24, withdrawalProcessingHours: 2 };

export interface ChannelPosition {
  code: string;
  name: string;
  ledgerHeldMinor: string;
  statementMinor: string | null;
  statementAt: Date | null;
  differenceMinor: string | null;
}

export interface CurrencyReport {
  currency: string;
  ok: boolean;
  liabilitiesMinor: string;
  memberMainMinor: string;
  memberTaskMinor: string;
  memberHeldMinor: string;
  ledgerHeldMinor: string;
  fundsHeldMinor: string;
  coverageMinor: string;
  unverifiedChannels: number;
  system: Record<string, string>;
  channels: ChannelPosition[];
  findings: { severity: 'warning' | 'critical'; kind: string; message: string }[];
}

export interface Report {
  ok: boolean;
  ranAt: string;
  currencies: CurrencyReport[];
  ledgerUnbalanced: { currency: string; debitsMinor: string; creditsMinor: string }[];
  drift: { accountId: string; kind: string; currency: string; cachedMinor: string; entriesMinor: string }[];
  stuck: { deposits: number; withdrawalsWaiting: number; withdrawalsProcessing: number };
}

export async function buildReport(db: Db): Promise<Report> {
  // Sequential on purpose: db may be a single transaction client.
  const balances = await     rows<{ currency_code: string; kind: string; total: string }>(
      db, 'SELECT currency_code, kind, sum(balance_minor)::text AS total FROM accounts GROUP BY currency_code, kind',
    );
  const channels = await rows<{ code: string; name: string; currency_code: string; ledger: string | null; statement: string | null; statement_at: Date | null }>(
      db,
      `SELECT c.code, c.name, c.currency_code, a.balance_minor::text AS ledger, s.balance_minor::text AS statement, s.recorded_at AS statement_at
       FROM payment_channels c
       LEFT JOIN accounts a ON a.kind = 'payment_clearing' AND a.channel_id = c.id
       LEFT JOIN LATERAL (SELECT balance_minor, recorded_at FROM float_snapshots f WHERE f.channel_id = c.id ORDER BY f.id DESC LIMIT 1) s ON true
       ORDER BY c.currency_code, c.name`,
    );
  const unbalanced = await rows<{ currency_code: string; debits: string; credits: string }>(
      db,
      `SELECT currency_code, sum(amount_minor) FILTER (WHERE side = 'debit')::text AS debits, sum(amount_minor) FILTER (WHERE side = 'credit')::text AS credits
       FROM ledger_entries GROUP BY currency_code
       HAVING coalesce(sum(amount_minor) FILTER (WHERE side = 'debit'), 0) <> coalesce(sum(amount_minor) FILTER (WHERE side = 'credit'), 0)`,
    );
  const drift = await rows<{ id: string; kind: string; currency_code: string; cached: string; computed: string }>(
      db,
      `SELECT a.id, a.kind, a.currency_code, a.balance_minor::text AS cached,
              coalesce(sum(CASE WHEN e.side = a.normal_side THEN e.amount_minor ELSE -e.amount_minor END), 0)::text AS computed
       FROM accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
       GROUP BY a.id HAVING a.balance_minor <> coalesce(sum(CASE WHEN e.side = a.normal_side THEN e.amount_minor ELSE -e.amount_minor END), 0)`,
    );
  const stuck = await one<{ deposits: string; waiting: string; processing: string }>(
      db,
      `SELECT (SELECT count(*) FROM deposits WHERE status = 'pending' AND created_at < now() - $1 * interval '1 hour') AS deposits,
              (SELECT count(*) FROM withdrawals WHERE status IN ('requested', 'approved') AND created_at < now() - $2 * interval '1 hour') AS waiting,
              (SELECT count(*) FROM withdrawals WHERE status = 'processing' AND processing_at < now() - $3 * interval '1 hour') AS processing`,
      [STUCK.depositPendingHours, STUCK.withdrawalWaitingHours, STUCK.withdrawalProcessingHours],
    );

  const currencies = [...new Set([...balances.map(b => b.currency_code), ...channels.map(c => c.currency_code)])].sort();
  const reports = currencies.map((currency): CurrencyReport => {
    const sum = (kind: string) => BigInt(balances.find(b => b.currency_code === currency && b.kind === kind)?.total ?? '0');
    const main = sum('member_main');
    const task = sum('member_task');
    const held = sum('member_withdrawal_hold');
    const liabilities = main + task + held;
    const positions = channels.filter(c => c.currency_code === currency).map((c): ChannelPosition => {
      const ledger = BigInt(c.ledger ?? '0');
      return {
        code: c.code, name: c.name, ledgerHeldMinor: ledger.toString(), statementMinor: c.statement, statementAt: c.statement_at,
        differenceMinor: c.statement === null ? null : (BigInt(c.statement) - ledger).toString(),
      };
    });
    const ledgerHeld = sum('payment_clearing');
    const funds = positions.reduce((acc, p) => acc + BigInt(p.statementMinor ?? p.ledgerHeldMinor), 0n);
    const findings: CurrencyReport['findings'] = [];
    if (liabilities > funds) {
      findings.push({ severity: 'critical', kind: 'solvency', message: `Members are owed more ${currency} than the channels hold. Withdrawals are paused.` });
    }
    for (const p of positions) {
      if (p.differenceMinor !== null && BigInt(p.differenceMinor) < 0n) {
        findings.push({ severity: 'warning', kind: 'channel_short', message: `${p.name} statement is below what the ledger says it holds.` });
      }
    }
    if (drift.some(d => d.currency_code === currency)) findings.push({ severity: 'critical', kind: 'drift', message: `Cached ${currency} balances differ from their ledger entries.` });
    if (unbalanced.some(u => u.currency_code === currency)) findings.push({ severity: 'critical', kind: 'unbalanced', message: `${currency} ledger debits and credits do not match.` });
    const system: Record<string, string> = {};
    for (const kind of ['platform_revenue', 'fees', 'referral_budget', 'promotions_budget', 'owner_capital', 'voucher_liability', 'suspense']) {
      system[kind] = sum(kind).toString();
    }
    return {
      currency, ok: !findings.some(f => f.severity === 'critical'), liabilitiesMinor: liabilities.toString(), memberMainMinor: main.toString(),
      memberTaskMinor: task.toString(), memberHeldMinor: held.toString(), ledgerHeldMinor: ledgerHeld.toString(), fundsHeldMinor: funds.toString(),
      coverageMinor: (funds - liabilities).toString(), unverifiedChannels: positions.filter(p => p.statementMinor === null).length, system, channels: positions, findings,
    };
  });
  return {
    ok: reports.every(r => r.ok) && unbalanced.length === 0 && drift.length === 0,
    ranAt: new Date().toISOString(),
    currencies: reports,
    ledgerUnbalanced: unbalanced.map(u => ({ currency: u.currency_code, debitsMinor: u.debits ?? '0', creditsMinor: u.credits ?? '0' })),
    drift: drift.map(d => ({ accountId: d.id, kind: d.kind, currency: d.currency_code, cachedMinor: d.cached, entriesMinor: d.computed })),
    stuck: { deposits: Number(stuck.deposits), withdrawalsWaiting: Number(stuck.waiting), withdrawalsProcessing: Number(stuck.processing) },
  };
}

async function raise(db: Db, kind: string, severity: 'warning' | 'critical', currency: string | null, message: string, details: object): Promise<void> {
  await db.query(
    `INSERT INTO alerts (kind, severity, currency_code, message, details) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (kind, currency_code) WHERE status <> 'resolved'
     DO UPDATE SET occurrences = alerts.occurrences + 1, last_seen_at = now(), message = EXCLUDED.message, details = EXCLUDED.details,
       severity = EXCLUDED.severity`,
    [kind, severity, currency, message, JSON.stringify(details)],
  );
}

// Runs the check, stores the report, raises alerts and pauses withdrawals where a critical finding exists.
// Pauses are lifted only by an admin, after a clean check.
export async function runReconciliation(pool: Pool, triggeredBy: number | null): Promise<{ id: number; report: Report }> {
  return withTransaction(pool, async db => {
    const report = await buildReport(db);
    for (const c of report.currencies) {
      for (const f of c.findings) await raise(db, `reconciliation.${f.kind}`, f.severity, c.currency, f.message, { coverageMinor: c.coverageMinor });
      if (!c.ok) {
        await setFlag(db, 'withdrawals_paused', c.currency, true, `Automatic: ${c.findings.filter(f => f.severity === 'critical').map(f => f.message).join(' ')}`.slice(0, 500), triggeredBy, true);
      }
    }
    const s = report.stuck;
    if (s.deposits > 0) await raise(db, 'payments.deposits_waiting', 'warning', null, `${s.deposits} deposit claim(s) waiting more than ${STUCK.depositPendingHours} hours.`, s);
    if (s.withdrawalsWaiting > 0) await raise(db, 'payments.withdrawals_waiting', 'warning', null, `${s.withdrawalsWaiting} withdrawal(s) waiting more than ${STUCK.withdrawalWaitingHours} hours.`, s);
    if (s.withdrawalsProcessing > 0) await raise(db, 'payments.payouts_stuck', 'warning', null, `${s.withdrawalsProcessing} payout(s) started more than ${STUCK.withdrawalProcessingHours} hours ago and not finished.`, s);
    const row = await one<{ id: string }>(db, 'INSERT INTO reconciliation_runs (ok, report, triggered_by) VALUES ($1, $2, $3) RETURNING id', [report.ok, JSON.stringify(report), triggeredBy]);
    return { id: Number(row.id), report };
  }, { isolation: 'repeatable read' });
}
