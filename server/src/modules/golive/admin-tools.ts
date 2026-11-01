import type { Pool } from '../../db/pool.js';
import { maybeOne } from '../../db/sql.js';
import { withTransaction } from '../../db/tx.js';
import type { Services } from '../../services.js';
import { STAFF_ROLES, type Role } from '../auth/context.js';
import { passwordProblems, verifyPassword } from '../auth/passwords.js';
import { newTotpSecret, openTotpSecret, otpauthUrl, verifyTotp } from '../auth/totp.js';
import { createUserDirect } from '../users/create.js';
import { goLiveStatus, recordSignoff } from './service.js';

// Bootstrap tools for a fresh live database (section 0, D20), shared by the npm scripts (admin:create, golive) and the
// migrate Lambda, since the AWS database is private. Errors carry plain messages for the operator.

export interface NewStaff {
  username: string; email: string; phone: string; country: string; role: string; password: string;
}

export async function createStaffAccount(services: Services, input: NewStaff): Promise<{ publicId: string; totpSecret: string; otpauthUrl: string }> {
  if (!(STAFF_ROLES as readonly string[]).includes(input.role)) throw new Error(`role must be one of: ${STAFF_ROLES.join(', ')}`);
  const username = input.username.toLowerCase();
  const problems = passwordProblems(input.password, { username, email: input.email, staff: true });
  if (problems.length > 0) throw new Error(problems.join(' '));
  const totpSecret = newTotpSecret();
  const user = await withTransaction(services.pool, db =>
    createUserDirect(db, services.config.dataEncryptionKey, {
      username, email: input.email, phone: input.phone, country: input.country.toUpperCase(),
      password: input.password, roles: [input.role as Role, 'member'], verified: true, totpSecret,
    }),
  );
  return { publicId: user.publicId, totpSecret, otpauthUrl: otpauthUrl(totpSecret, username) };
}

// True while the database has no active admin: the Lambda creates only the first one; later staff come from the console.
export async function hasActiveAdmin(pool: Pool): Promise<boolean> {
  const row = await maybeOne(pool, `SELECT 1 FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'admin' WHERE u.status = 'active' LIMIT 1`);
  return row !== null;
}

export interface Signoff {
  command: 'sign' | 'revoke'; item: string; username: string; password: string; code: string; note?: string | null;
}

// Signs or revokes one go-live item as an admin proving password + TOTP. Audited.
export async function signGoLiveItem(pool: Pool, dataEncryptionKey: Buffer, input: Signoff): Promise<void> {
  const items = await goLiveStatus(pool);
  if (!items.some(i => i.key === input.item)) throw new Error(`Unknown item. Items: ${items.map(i => i.key).join(', ')}`);
  const admin = await maybeOne<{ id: string; password_hash: string; secret_ciphertext: Buffer | null; last_used_step: string | null }>(
    pool,
    `SELECT u.id, u.password_hash, t.secret_ciphertext, t.last_used_step FROM users u
     JOIN user_roles r ON r.user_id = u.id AND r.role = 'admin'
     LEFT JOIN totp_credentials t ON t.user_id = u.id AND t.enabled_at IS NOT NULL
     WHERE u.username = $1 AND u.status = 'active'`,
    [input.username.toLowerCase()],
  );
  if (!admin || !admin.secret_ciphertext || !(await verifyPassword(admin.password_hash, input.password))) {
    throw new Error('Not an admin with two-step verification, or wrong password.');
  }
  const step = verifyTotp(openTotpSecret(dataEncryptionKey, admin.secret_ciphertext), input.code, admin.last_used_step === null ? null : Number(admin.last_used_step), new Date());
  if (step === null) throw new Error('Wrong authenticator code.');
  const note = input.note ?? null;
  await withTransaction(pool, async db => {
    await db.query('UPDATE totp_credentials SET last_used_step = $2 WHERE user_id = $1', [admin.id, step]);
    await recordSignoff(db, input.item, Number(admin.id), input.command, note);
    await db.query(`INSERT INTO audit_log (actor_user_id, actor_roles, action, target_type, target_id, reason) VALUES ($1, '{admin}', $2, 'go_live_item', $3, $4)`, [
      admin.id, `golive.${input.command}`, input.item, note,
    ]);
  });
}
