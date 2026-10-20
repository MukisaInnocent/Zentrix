import { z } from 'zod';
import { maybeOne, one } from '../../db/sql.js';
import { withTransaction } from '../../db/tx.js';
import { parse } from '../../http/validate.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { badRequest, forbidden } from '../../lib/errors.js';
import type { Services } from '../../services.js';
import { hashPassword, passwordProblems, verifyPassword } from './passwords.js';
import { revokeUserSessions, TOKEN_PATTERN } from './sessions.js';

const RESET_TTL_MS = 30 * 60_000;

export const ForgotSchema = z.strictObject({ email: z.string().trim().toLowerCase().max(254).pipe(z.email()) });
export const ResetSchema = z.strictObject({ token: z.string().regex(TOKEN_PATTERN), password: z.string().max(256) });
export const ChangeSchema = z.strictObject({ currentPassword: z.string().min(1).max(256), newPassword: z.string().max(256) });

const testNote = (services: Services) => (services.config.appMode === 'test' ? '\n\nTEST MODE: no real money.' : '');

// Always answers the same way, whether or not the email belongs to an account.
export async function requestPasswordReset(services: Services, raw: unknown, ip: string | undefined): Promise<void> {
  const { email } = parse(ForgotSchema, raw);
  const now = services.now();
  const user = await maybeOne<{ id: string }>(
    services.pool,
    `SELECT id FROM users WHERE email = $1 AND status <> 'closed' AND anonymized_at IS NULL`,
    [email],
  );
  if (!user) return;
  const token = randomToken(32);
  await services.pool.query('INSERT INTO password_resets (token_hash, user_id, expires_at, ip) VALUES ($1, $2, $3, $4)', [
    sha256(token), user.id, new Date(now.getTime() + RESET_TTL_MS), ip ?? null,
  ]);
  try {
    await services.mailer.send({
      to: email,
      subject: 'Reset your Zentrix password',
      text: `Someone asked to reset the password for this Zentrix account. To choose a new password, open this link within 30 minutes:\n\n${services.config.publicOrigin}/reset-password.html#token=${token}\n\nIf you did not ask for this, ignore this email; your password stays the same.${testNote(services)}`,
    });
  } catch (err) {
    services.logger.error({ err }, 'password reset email failed');
  }
}

export async function resetPassword(services: Services, raw: unknown): Promise<void> {
  const input = parse(ResetSchema, raw);
  const now = services.now();
  const target = await maybeOne<{ user_id: string; username: string; email: string }>(
    services.pool,
    `SELECT r.user_id, u.username, u.email FROM password_resets r JOIN users u ON u.id = r.user_id
     WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > $2`,
    [sha256(input.token), now],
  );
  if (!target) throw badRequest('reset.invalid_link', 'This reset link is invalid or has expired. Ask for a new one.');
  const problems = passwordProblems(input.password, { username: target.username, email: target.email });
  if (problems.length > 0) throw badRequest('validation_failed', problems[0] ?? 'Choose a stronger password.', { password: problems });
  const hash = await hashPassword(input.password);
  const done = await withTransaction(services.pool, async db => {
    const claimed = await db.query('UPDATE password_resets SET used_at = $2 WHERE token_hash = $1 AND used_at IS NULL', [sha256(input.token), now]);
    if (claimed.rowCount !== 1) return false;
    await db.query('UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL WHERE id = $1', [target.user_id, hash]);
    await db.query('UPDATE password_resets SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL', [target.user_id, now]);
    await revokeUserSessions(db, Number(target.user_id), 'password_reset');
    await db.query(`INSERT INTO auth_events (user_id, kind) VALUES ($1, 'password_reset')`, [target.user_id]);
    return true;
  });
  if (!done) throw badRequest('reset.invalid_link', 'This reset link is invalid or has expired. Ask for a new one.');
  await notifyPasswordChanged(services, target.email);
}

export async function changePassword(services: Services, userId: number, sessionId: number, raw: unknown): Promise<void> {
  const input = parse(ChangeSchema, raw);
  const user = await one<{ password_hash: string; username: string; email: string }>(
    services.pool, 'SELECT password_hash, username, email FROM users WHERE id = $1', [userId],
  );
  if (!(await verifyPassword(user.password_hash, input.currentPassword))) {
    throw forbidden('auth.current_password_wrong', 'Your current password is not right.');
  }
  const problems = passwordProblems(input.newPassword, { username: user.username, email: user.email });
  if (problems.length > 0) throw badRequest('validation_failed', problems[0] ?? 'Choose a stronger password.', { newPassword: problems });
  const hash = await hashPassword(input.newPassword);
  await withTransaction(services.pool, async db => {
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, hash]);
    await revokeUserSessions(db, userId, 'password_changed', sessionId);
    await db.query(`INSERT INTO auth_events (user_id, kind) VALUES ($1, 'password_changed')`, [userId]);
  });
  await notifyPasswordChanged(services, user.email);
}

async function notifyPasswordChanged(services: Services, email: string): Promise<void> {
  try {
    await services.mailer.send({
      to: email,
      subject: 'Your Zentrix password was changed',
      text: `The password for your Zentrix account was just changed and other devices were signed out.\n\nIf this was not you, reset your password now and contact support.${testNote(services)}`,
    });
  } catch (err) {
    services.logger.error({ err }, 'password change notice failed');
  }
}
