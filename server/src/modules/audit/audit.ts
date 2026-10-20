import type { Request } from 'express';
import type { Db } from '../../db/sql.js';

export interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

// Appends one row to audit_log: who, what, before and after, IP, time (section 11). Call it inside the
// same transaction as the change so the change and its record commit together. Never pass secrets.
export async function audit(db: Db, req: Request | null, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_user_id, actor_roles, action, target_type, target_id, before, after, reason, ip, user_agent, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      req?.auth?.userId ?? null,
      req?.auth?.roles ?? [],
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.reason ?? null,
      req?.ip ?? null,
      req?.get('user-agent')?.slice(0, 300) ?? null,
      req?.id ?? null,
    ],
  );
}
