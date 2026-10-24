import type { PoolClient } from '../../db/pool.js';
import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';

// Problems members report about a deposit or withdrawal ("I paid but it is not credited", "I did not
// receive my payout"), and the thread with staff until it is resolved.

export const ISSUE_CATEGORIES = ['not_credited', 'wrong_amount', 'not_received', 'delayed', 'other'] as const;
export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];

const MAX_OPEN_PER_MEMBER = 5;

export const ISSUE_SELECT = `
  SELECT i.id, i.public_id, i.user_id, i.subject_type, i.category, i.status, i.resolution, i.resolved_at, i.created_at, i.updated_at,
         d.reference AS deposit_ref, d.public_id AS deposit_id, w.reference AS withdrawal_ref, w.public_id AS withdrawal_id,
         u.username, a.username AS assigned_to,
         (SELECT body FROM payment_issue_messages m WHERE m.issue_id = i.id ORDER BY m.id LIMIT 1) AS first_message,
         (SELECT count(*) FROM payment_issue_messages m WHERE m.issue_id = i.id) AS message_count,
         (SELECT from_staff FROM payment_issue_messages m WHERE m.issue_id = i.id ORDER BY m.id DESC LIMIT 1) AS last_from_staff
  FROM payment_issues i
  JOIN users u ON u.id = i.user_id
  LEFT JOIN users a ON a.id = i.assigned_to
  LEFT JOIN deposits d ON d.id = i.deposit_id
  LEFT JOIN withdrawals w ON w.id = i.withdrawal_id`;

export interface IssueRow {
  id: string; public_id: string; user_id: string; subject_type: string; category: string; status: string; resolution: string | null;
  resolved_at: Date | null; created_at: Date; updated_at: Date; deposit_ref: string | null; deposit_id: string | null;
  withdrawal_ref: string | null; withdrawal_id: string | null; username: string; assigned_to: string | null; first_message: string | null;
  message_count: string; last_from_staff: boolean | null;
}

export const issueView = (i: IssueRow) => ({
  id: i.public_id, subjectType: i.subject_type, category: i.category, status: i.status, resolution: i.resolution, resolvedAt: i.resolved_at,
  createdAt: i.created_at, updatedAt: i.updated_at,
  subject: i.deposit_ref ? { type: 'deposit', id: i.deposit_id, reference: i.deposit_ref } : i.withdrawal_ref ? { type: 'withdrawal', id: i.withdrawal_id, reference: i.withdrawal_ref } : null,
  member: i.username, assignedTo: i.assigned_to, summary: i.first_message, messageCount: Number(i.message_count), awaitingStaff: i.status !== 'resolved' && i.last_from_staff === false,
});

export async function messagesOf(db: Db, issueId: string) {
  const list = await rows<{ id: string; body: string; from_staff: boolean; created_at: Date; author: string }>(
    db,
    `SELECT m.id, m.body, m.from_staff, m.created_at, u.username AS author FROM payment_issue_messages m JOIN users u ON u.id = m.author_user_id
     WHERE m.issue_id = $1 ORDER BY m.id`,
    [issueId],
  );
  // Members see "Zentrix support" rather than which staff member wrote.
  return list.map(m => ({ id: m.id, body: m.body, fromStaff: m.from_staff, createdAt: m.created_at, author: m.author }));
}

export async function openIssue(db: PoolClient, userId: number, input: { subjectType: 'deposit' | 'withdrawal' | 'other'; reference?: string | undefined; category: IssueCategory; message: string }) {
  let depositId: string | null = null;
  let withdrawalId: string | null = null;
  if (input.subjectType !== 'other') {
    const table = input.subjectType === 'deposit' ? 'deposits' : 'withdrawals';
    const found = await maybeOne<{ id: string }>(db, `SELECT id FROM ${table} WHERE reference = $1 AND user_id = $2`, [input.reference ?? '', userId]);
    if (!found) throw badRequest('validation_failed', 'Choose one of your own payments.', { reference: ['Choose one of your own payments.'] });
    if (input.subjectType === 'deposit') depositId = found.id;
    else withdrawalId = found.id;
    const dup = await maybeOne(db, `SELECT 1 FROM payment_issues WHERE ${input.subjectType}_id = $1 AND status <> 'resolved'`, [found.id]);
    if (dup) throw conflict('issue.already_open', 'There is already an open report for this payment. Add a message to it instead.');
  }
  const open = await one<{ n: string }>(db, `SELECT count(*) AS n FROM payment_issues WHERE user_id = $1 AND status <> 'resolved'`, [userId]);
  if (Number(open.n) >= MAX_OPEN_PER_MEMBER) throw badRequest('issue.too_many_open', 'You have several open reports. Please wait for support to answer them.');
  const issue = await one<{ id: string }>(
    db,
    'INSERT INTO payment_issues (user_id, subject_type, deposit_id, withdrawal_id, category) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [userId, input.subjectType, depositId, withdrawalId, input.category],
  );
  await db.query('INSERT INTO payment_issue_messages (issue_id, author_user_id, from_staff, body) VALUES ($1, $2, false, $3)', [issue.id, userId, input.message]);
  return issueView(await one<IssueRow>(db, `${ISSUE_SELECT} WHERE i.id = $1`, [issue.id]));
}

export async function findIssue(db: Db, publicId: string, ownerId?: number): Promise<IssueRow> {
  const row = await maybeOne<IssueRow>(db, `${ISSUE_SELECT} WHERE i.public_id = $1`, [publicId]);
  if (!row || (ownerId !== undefined && Number(row.user_id) !== ownerId)) throw notFound();
  return row;
}

export async function addMessage(db: PoolClient, issue: IssueRow, authorId: number, fromStaff: boolean, body: string): Promise<void> {
  if (issue.status === 'resolved' && !fromStaff) {
    // A member writing on a resolved report reopens it.
    await db.query(`UPDATE payment_issues SET status = 'open', resolved_at = NULL, resolved_by = NULL WHERE id = $1`, [issue.id]);
  } else if (fromStaff && issue.status === 'open') {
    await db.query(`UPDATE payment_issues SET status = 'in_progress', assigned_to = coalesce(assigned_to, $2) WHERE id = $1`, [issue.id, authorId]);
  }
  await db.query('INSERT INTO payment_issue_messages (issue_id, author_user_id, from_staff, body) VALUES ($1, $2, $3, $4)', [issue.id, authorId, fromStaff, body]);
}

export async function setIssueStatus(db: PoolClient, issue: IssueRow, staffId: number, status: 'open' | 'in_progress' | 'resolved', resolution: string | null): Promise<void> {
  if (status === 'resolved' && !resolution) throw badRequest('validation_failed', 'Write what was done to resolve it.', { resolution: ['Write what was done.'] });
  await db.query(
    `UPDATE payment_issues SET status = $2, assigned_to = coalesce(assigned_to, $3),
       resolution = CASE WHEN $2 = 'resolved' THEN $4 ELSE resolution END,
       resolved_by = CASE WHEN $2 = 'resolved' THEN $3::bigint END,
       resolved_at = CASE WHEN $2 = 'resolved' THEN now() END
     WHERE id = $1`,
    [issue.id, status, staffId, resolution],
  );
  if (status === 'resolved' && resolution) {
    await db.query('INSERT INTO payment_issue_messages (issue_id, author_user_id, from_staff, body) VALUES ($1, $2, true, $3)', [issue.id, staffId, `Resolved: ${resolution}`]);
  }
}
