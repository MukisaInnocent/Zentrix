import QRCode from 'qrcode';
import { z } from 'zod';
import { maybeOne, one } from '../../db/sql.js';
import type { Db } from '../../db/sql.js';
import { withTransaction } from '../../db/tx.js';
import { parse } from '../../http/validate.js';
import { randomCode } from '../../lib/crypto.js';
import { badRequest, conflict, forbidden } from '../../lib/errors.js';
import type { Services } from '../../services.js';
import type { AuthContext } from './context.js';
import { verifyPassword } from './passwords.js';
import { rotateSession } from './sessions.js';
import { codeHash, newTotpSecret, normaliseRecoveryCode, openTotpSecret, otpauthUrl, sealTotpSecret, verifyTotp } from './totp.js';

export const CodeSchema = z.strictObject({ code: z.string().trim().regex(/^[0-9]{6}$/, { error: 'Enter the 6-digit code.' }) });
export const DisableSchema = z.strictObject({ password: z.string().min(1).max(256), code: z.string().trim().regex(/^[0-9]{6}$/) });

const RECOVERY_CODE_COUNT = 10;

export async function totpStatus(db: Db, userId: number): Promise<{ enabled: boolean; pending: boolean; recoveryCodesLeft: number }> {
  const row = await maybeOne<{ enabled: boolean; left: string }>(
    db,
    `SELECT t.enabled_at IS NOT NULL AS enabled,
            (SELECT count(*) FROM recovery_codes r WHERE r.user_id = t.user_id AND r.used_at IS NULL) AS left
     FROM totp_credentials t WHERE t.user_id = $1`,
    [userId],
  );
  return { enabled: row?.enabled ?? false, pending: row !== null && !row.enabled, recoveryCodesLeft: Number(row?.left ?? 0) };
}

// Starts (or restarts) enrolment: a new secret is stored encrypted and shown once as a QR code.
export async function setupTotp(services: Services, auth: AuthContext) {
  const secret = newTotpSecret();
  const sealed = sealTotpSecret(services.config.dataEncryptionKey, secret);
  const result = await services.pool.query(
    `INSERT INTO totp_credentials (user_id, secret_ciphertext) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET secret_ciphertext = EXCLUDED.secret_ciphertext, last_used_step = NULL
       WHERE totp_credentials.enabled_at IS NULL`,
    [auth.userId, sealed],
  );
  if (result.rowCount !== 1) throw conflict('totp.already_enabled', 'Two-step verification is already on.');
  const url = otpauthUrl(secret, auth.username);
  const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return { secret, otpauthUrl: url, qrSvg };
}

async function issueRecoveryCodes(db: Db, key: Buffer, userId: number): Promise<string[]> {
  await db.query('DELETE FROM recovery_codes WHERE user_id = $1', [userId]);
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const raw = randomCode(8);
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
    await db.query('INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)', [userId, codeHash(key, 'recovery', normaliseRecoveryCode(raw))]);
  }
  return codes;
}

async function checkCode(db: Db, services: Services, userId: number, code: string, enabled: boolean): Promise<void> {
  const cred = await maybeOne<{ secret_ciphertext: Buffer; last_used_step: string | null }>(
    db,
    `SELECT secret_ciphertext, last_used_step FROM totp_credentials
     WHERE user_id = $1 AND (enabled_at IS NOT NULL) = $2 FOR UPDATE`,
    [userId, enabled],
  );
  if (!cred) throw badRequest('totp.not_set_up', enabled ? 'Two-step verification is not on.' : 'Start the set-up again.');
  const secret = openTotpSecret(services.config.dataEncryptionKey, cred.secret_ciphertext);
  const step = verifyTotp(secret, code, cred.last_used_step === null ? null : Number(cred.last_used_step), services.now());
  if (step === null) throw badRequest('totp.code_invalid', 'That code is not right. Use the current code from your app.');
  await db.query('UPDATE totp_credentials SET last_used_step = $2 WHERE user_id = $1', [userId, step]);
}

// Confirms enrolment with a first code, returns recovery codes once, and marks this session verified.
export async function enableTotp(services: Services, auth: AuthContext, raw: unknown) {
  const { code } = parse(CodeSchema, raw);
  const now = services.now();
  return withTransaction(services.pool, async db => {
    await checkCode(db, services, auth.userId, code, false);
    await db.query('UPDATE totp_credentials SET enabled_at = $2 WHERE user_id = $1', [auth.userId, now]);
    const recoveryCodes = await issueRecoveryCodes(db, services.config.dataEncryptionKey, auth.userId);
    await db.query(`INSERT INTO auth_events (user_id, kind) VALUES ($1, 'totp_enabled')`, [auth.userId]);
    const token = await rotateSession(db, auth.sessionId, now, { mfaVerified: true });
    return { recoveryCodes, token };
  });
}

// Step-up for a session that was created before verification (for example a role granted later).
export async function verifySessionTotp(services: Services, auth: AuthContext, raw: unknown): Promise<string | null> {
  const { code } = parse(CodeSchema, raw);
  return withTransaction(services.pool, async db => {
    await checkCode(db, services, auth.userId, code, true);
    return rotateSession(db, auth.sessionId, services.now(), { mfaVerified: true });
  });
}

export async function disableTotp(services: Services, auth: AuthContext, raw: unknown): Promise<void> {
  if (auth.isStaff) throw forbidden('totp.required_for_staff', 'Staff accounts must keep two-step verification on.');
  const input = parse(DisableSchema, raw);
  const user = await one<{ password_hash: string }>(services.pool, 'SELECT password_hash FROM users WHERE id = $1', [auth.userId]);
  if (!(await verifyPassword(user.password_hash, input.password))) {
    throw forbidden('auth.current_password_wrong', 'Your current password is not right.');
  }
  await withTransaction(services.pool, async db => {
    await checkCode(db, services, auth.userId, input.code, true);
    await db.query('DELETE FROM recovery_codes WHERE user_id = $1', [auth.userId]);
    await db.query('DELETE FROM totp_credentials WHERE user_id = $1', [auth.userId]);
    await db.query(`INSERT INTO auth_events (user_id, kind) VALUES ($1, 'totp_disabled')`, [auth.userId]);
  });
}

export async function regenerateRecoveryCodes(services: Services, auth: AuthContext, raw: unknown): Promise<string[]> {
  const { code } = parse(CodeSchema, raw);
  return withTransaction(services.pool, async db => {
    await checkCode(db, services, auth.userId, code, true);
    return issueRecoveryCodes(db, services.config.dataEncryptionKey, auth.userId);
  });
}
