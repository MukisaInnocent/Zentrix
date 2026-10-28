import { z } from 'zod';
import type { PoolClient } from '../../db/pool.js';
import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';
import { withTransaction } from '../../db/tx.js';
import { parse } from '../../http/validate.js';
import { badRequest, conflict, DB_ERRORS, forbidden, pgErrorCode } from '../../lib/errors.js';
import { isMobileLike, parseInternational, PHONE_HELP } from '../../lib/phone.js';
import type { Services } from '../../services.js';
import { audit } from '../audit/audit.js';
import { sendTemplated } from '../email/templates.js';
import type { Request } from 'express';
import type { AuthContext } from './context.js';
import { verifyPassword } from './passwords.js';
import { revokeUserSessions } from './sessions.js';

// Members change their password, email or phone only after contacting an admin (owner, 2026-10-25). The admin
// checks who they are and unlocks that one change for 24 hours; the member then makes it once, with their
// current password. Every step is audited.

export const CHANGE_KINDS = ['password', 'email', 'phone'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
export const GRANT_HOURS = 24;
const WITHDRAWAL_LOCK_MS = 48 * 3_600_000;

export interface OpenGrant {
  kind: ChangeKind;
  expiresAt: Date;
}

export async function openGrants(db: Db, userId: number): Promise<OpenGrant[]> {
  const list = await rows<{ kind: ChangeKind; expires_at: Date }>(
    db,
    `SELECT DISTINCT ON (kind) kind, expires_at FROM profile_change_grants
     WHERE user_id = $1 AND used_at IS NULL AND expires_at > now() ORDER BY kind, id DESC`,
    [userId],
  );
  return list.map(g => ({ kind: g.kind, expiresAt: g.expires_at }));
}

// Uses up the member's newest open grant for this kind, or refuses.
export async function consumeGrant(db: PoolClient, userId: number, kind: ChangeKind): Promise<void> {
  const grant = await maybeOne<{ id: string }>(
    db,
    `SELECT id FROM profile_change_grants WHERE user_id = $1 AND kind = $2 AND used_at IS NULL AND expires_at > now()
     ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    [userId, kind],
  );
  if (!grant) {
    throw forbidden('change.locked', `Contact the admin to unlock a ${kind} change. They will check it is you first.`);
  }
  await db.query('UPDATE profile_change_grants SET used_at = now() WHERE id = $1', [grant.id]);
}

export async function grantChange(db: PoolClient, adminId: number, userId: number, kind: ChangeKind, verification: string): Promise<Date> {
  const expiresAt = new Date(Date.now() + GRANT_HOURS * 3_600_000);
  await db.query(
    'INSERT INTO profile_change_grants (user_id, kind, granted_by, verification, expires_at) VALUES ($1, $2, $3, $4, $5)',
    [userId, kind, adminId, verification, expiresAt],
  );
  return expiresAt;
}

const EmailSchema = z.strictObject({
  newEmail: z.string().trim().toLowerCase().max(254).pipe(z.email({ error: 'Enter a valid email address.' })),
  password: z.string().max(256),
});
const PhoneSchema = z.strictObject({ newPhone: z.string().trim().min(4).max(32), password: z.string().max(256) });

async function checkPassword(services: Services, userId: number, password: string): Promise<{ email: string | null; username: string; dialCode: string }> {
  const user = await one<{ password_hash: string; email: string | null; username: string; dial_code: string }>(
    services.pool,
    'SELECT u.password_hash, u.email, u.username, c.dial_code FROM users u JOIN countries c ON c.code = u.country_code WHERE u.id = $1', [userId],
  );
  if (!(await verifyPassword(user.password_hash, password))) throw forbidden('auth.current_password_wrong', 'Your current password is not right.');
  return { email: user.email, username: user.username, dialCode: user.dial_code };
}

async function notify(services: Services, kind: 'email_changed' | 'email_updated' | 'phone_changed', to: string | null, userId: number, values: Record<string, string>): Promise<void> {
  if (!to) return;
  await sendTemplated(services, { kind, to, userId, values });
}

export async function changeEmail(services: Services, req: Request, auth: AuthContext, raw: unknown): Promise<void> {
  const input = parse(EmailSchema, raw);
  const user = await checkPassword(services, auth.userId, input.password);
  try {
    await withTransaction(services.pool, async db => {
      await consumeGrant(db, auth.userId, 'email');
      await db.query('UPDATE users SET email = $2, email_verified_at = now() WHERE id = $1', [auth.userId, input.newEmail]);
      await revokeUserSessions(db, auth.userId, 'email_changed', auth.sessionId);
      await audit(db, req, { action: 'member.email_changed', targetType: 'user', targetId: auth.publicId, before: { email: user.email }, after: { email: input.newEmail } });
    });
  } catch (err) {
    if (pgErrorCode(err) === DB_ERRORS.uniqueViolation) throw conflict('change.email_taken', 'That email address belongs to another account.');
    throw err;
  }
  await notify(services, 'email_changed', user.email, auth.userId, { username: user.username, newEmail: input.newEmail });
  await notify(services, 'email_updated', input.newEmail, auth.userId, { username: user.username });
}

export async function changePhone(services: Services, req: Request, auth: AuthContext, raw: unknown): Promise<{ withdrawalsLockedUntil: Date }> {
  const input = parse(PhoneSchema, raw);
  const user = await checkPassword(services, auth.userId, input.password);
  const phone = parseInternational(input.newPhone);
  const bad = (message: string) => badRequest('validation_failed', message, { newPhone: [message] });
  if (!phone) throw bad(`Enter a valid mobile number. ${PHONE_HELP}`);
  if (phone.countryCallingCode !== user.dialCode) throw bad(`Use a number that starts with +${user.dialCode}.`);
  if (!isMobileLike(phone)) throw bad('Use a mobile number. Payouts go to this number.');
  const lockUntil = new Date(services.now().getTime() + WITHDRAWAL_LOCK_MS);
  try {
    await withTransaction(services.pool, async db => {
      await consumeGrant(db, auth.userId, 'phone');
      const before = await one<{ phone_e164: string | null }>(db, 'SELECT phone_e164 FROM users WHERE id = $1 FOR UPDATE', [auth.userId]);
      await db.query(`SELECT set_config('zentrix.admin_change', 'on', true)`);
      await db.query('UPDATE users SET phone_e164 = $2, phone_verified_at = now(), withdrawals_locked_until = $3 WHERE id = $1', [auth.userId, phone.number, lockUntil]);
      await revokeUserSessions(db, auth.userId, 'phone_changed', auth.sessionId);
      await audit(db, req, {
        action: 'member.phone_changed', targetType: 'user', targetId: auth.publicId,
        before: { phone: before.phone_e164 }, after: { phone: phone.number, withdrawalsLockedUntil: lockUntil.toISOString() },
        reason: 'Unlocked by an admin after identity verification',
      });
    });
  } catch (err) {
    if (pgErrorCode(err) === DB_ERRORS.uniqueViolation) throw conflict('change.phone_taken', 'That number belongs to another account.');
    throw err;
  }
  await notify(services, 'phone_changed', user.email, auth.userId, { username: user.username });
  return { withdrawalsLockedUntil: lockUntil };
}
