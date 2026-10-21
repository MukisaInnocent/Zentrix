import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { z } from 'zod';
import { maybeOne, one } from '../../db/sql.js';
import { withTransaction } from '../../db/tx.js';
import { parse } from '../../http/validate.js';
import { randomToken, safeEqual, sha256 } from '../../lib/crypto.js';
import { AppError, unauthorized } from '../../lib/errors.js';
import type { Services } from '../../services.js';
import { isStaffRole, type Role } from './context.js';
import { burnPasswordCheck, verifyPassword } from './passwords.js';
import type { RequestMeta } from './register.js';
import { createSession, TOKEN_PATTERN, type IssuedSession } from './sessions.js';
import { codeHash, normaliseRecoveryCode, openTotpSecret, verifyTotp } from './totp.js';

export const LoginSchema = z.strictObject({
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(256),
});

export const MfaLoginSchema = z.strictObject({
  challengeToken: z.string().regex(TOKEN_PATTERN),
  code: z.string().trim().min(6).max(12),
});

const LOCK_AFTER = 10;
const LOCK_MINUTES = 15;
const CHALLENGE_TTL_MS = 5 * 60_000;
const CHALLENGE_MAX_ATTEMPTS = 5;

// One message for every failure, so responses do not reveal which accounts exist (section 11).
const badCredentials = () =>
  unauthorized(
    'auth.invalid_credentials',
    'Those sign-in details are not right, or the account is locked for a while after too many attempts.',
  );

export type LoginResult =
  | { kind: 'session'; userId: number; session: IssuedSession; mfaEnrollmentRequired: boolean }
  | { kind: 'mfa'; challengeToken: string };

interface LoginRow {
  id: string;
  password_hash: string;
  status: string;
  locked_until: Date | null;
  mfa_enabled: boolean;
  roles: Role[];
}

function findUserByIdentifier(pool: Services['pool'], identifier: string): Promise<LoginRow | null> {
  const clean = identifier.trim();
  const lower = clean.toLowerCase();

  if (lower.includes('@')) {
    return maybeOne<LoginRow>(
      pool,
      `SELECT u.id, u.password_hash, u.status, u.locked_until, t.enabled_at IS NOT NULL AS mfa_enabled,
              coalesce((SELECT array_agg(role) FROM user_roles r WHERE r.user_id = u.id), '{}') AS roles
       FROM users u LEFT JOIN totp_credentials t ON t.user_id = u.id
       WHERE u.email = $1 AND u.anonymized_at IS NULL`,
      [lower],
    );
  }

  // Check phone variants: national format (0700...) or international (+256...)
  const digits = clean.replace(/[\s\-()]/g, '');
  let phoneE164: string | null = null;
  if (/^\+?\d{8,15}$/.test(digits)) {
    const parsed =
      (digits.startsWith('+') ? parsePhoneNumberFromString(digits) : null) ??
      parsePhoneNumberFromString(digits, 'UG') ??
      parsePhoneNumberFromString(digits, 'KE') ??
      parsePhoneNumberFromString(digits, 'TZ') ??
      parsePhoneNumberFromString(digits, 'RW') ??
      parsePhoneNumberFromString(digits, 'NG');
    if (parsed?.isValid()) phoneE164 = parsed.number;
  }

  if (phoneE164) {
    return maybeOne<LoginRow>(
      pool,
      `SELECT u.id, u.password_hash, u.status, u.locked_until, t.enabled_at IS NOT NULL AS mfa_enabled,
              coalesce((SELECT array_agg(role) FROM user_roles r WHERE r.user_id = u.id), '{}') AS roles
       FROM users u LEFT JOIN totp_credentials t ON t.user_id = u.id
       WHERE (u.phone_e164 = $1 OR u.username = $2) AND u.anonymized_at IS NULL`,
      [phoneE164, lower],
    );
  }

  return maybeOne<LoginRow>(
    pool,
    `SELECT u.id, u.password_hash, u.status, u.locked_until, t.enabled_at IS NOT NULL AS mfa_enabled,
            coalesce((SELECT array_agg(role) FROM user_roles r WHERE r.user_id = u.id), '{}') AS roles
     FROM users u LEFT JOIN totp_credentials t ON t.user_id = u.id
     WHERE u.username = $1 AND u.anonymized_at IS NULL`,
    [lower],
  );
}

export async function login(services: Services, raw: unknown, meta: RequestMeta): Promise<LoginResult> {
  const input = parse(LoginSchema, raw);
  const { pool, config } = services;
  const now = services.now();
  const user = await findUserByIdentifier(pool, input.identifier);
  if (!user) {
    await burnPasswordCheck(input.password);
    throw badCredentials();
  }
  const userId = Number(user.id);
  const locked = user.locked_until !== null && user.locked_until > now;
  const passwordOk = (await verifyPassword(user.password_hash, input.password)) && !locked;
  if (!passwordOk || user.status === 'closed') {
    if (!locked) {
      await pool.query(
        `UPDATE users SET failed_login_count = CASE WHEN failed_login_count + 1 >= $2 THEN 0 ELSE failed_login_count + 1 END,
                locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN $3 ELSE locked_until END
         WHERE id = $1`,
        [userId, LOCK_AFTER, new Date(now.getTime() + LOCK_MINUTES * 60_000)],
      );
    }
    await pool.query(`INSERT INTO auth_events (user_id, kind, ip, user_agent) VALUES ($1, 'login_failed', $2, $3)`, [
      userId, meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null,
    ]);
    throw badCredentials();
  }

  if (user.mfa_enabled) {
    const challengeToken = randomToken(32);
    await pool.query('INSERT INTO mfa_challenges (token_hash, user_id, expires_at, ip) VALUES ($1, $2, $3, $4)', [
      sha256(challengeToken), userId, new Date(now.getTime() + CHALLENGE_TTL_MS), meta.ip ?? null,
    ]);
    return { kind: 'mfa', challengeToken };
  }

  const staff = user.roles.some(isStaffRole);
  const session = await withTransaction(pool, async db => {
    await db.query('UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = $2 WHERE id = $1', [userId, now]);
    await db.query(`INSERT INTO auth_events (user_id, kind, ip, user_agent) VALUES ($1, 'login', $2, $3)`, [
      userId, meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null,
    ]);
    return createSession(db, config.csrfSecret, { userId, staff, mfaVerified: false, ip: meta.ip, userAgent: meta.userAgent, now });
  });
  // Staff without an authenticator get a session that can only enrol one (section 11: TOTP mandatory).
  return { kind: 'session', userId, session, mfaEnrollmentRequired: staff };
}

// Second login step: a TOTP code, or one single-use recovery code.
export async function loginWithMfa(services: Services, raw: unknown, meta: RequestMeta): Promise<{ userId: number; session: IssuedSession }> {
  const input = parse(MfaLoginSchema, raw);
  const { config } = services;
  const now = services.now();
  const result = await withTransaction(services.pool, async db => {
    const challenge = await maybeOne<{ user_id: string; attempts: number }>(
      db,
      `SELECT user_id, attempts FROM mfa_challenges WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2 FOR UPDATE`,
      [sha256(input.challengeToken), now],
    );
    if (!challenge || challenge.attempts >= CHALLENGE_MAX_ATTEMPTS) return { error: 'expired' as const };
    const userId = Number(challenge.user_id);
    await db.query('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE token_hash = $1', [sha256(input.challengeToken)]);
    const cred = await one<{ secret_ciphertext: Buffer; last_used_step: string | null }>(
      db,
      'SELECT secret_ciphertext, last_used_step FROM totp_credentials WHERE user_id = $1 AND enabled_at IS NOT NULL FOR UPDATE',
      [userId],
    );
    let ok = false;
    if (/^[0-9]{6}$/.test(input.code)) {
      const secret = openTotpSecret(config.dataEncryptionKey, cred.secret_ciphertext);
      const step = verifyTotp(secret, input.code, cred.last_used_step === null ? null : Number(cred.last_used_step), now);
      if (step !== null) {
        await db.query('UPDATE totp_credentials SET last_used_step = $2 WHERE user_id = $1', [userId, step]);
        ok = true;
      }
    } else {
      const hash = codeHash(config.dataEncryptionKey, 'recovery', normaliseRecoveryCode(input.code));
      const codes = await db.query<{ id: string; code_hash: Buffer }>(
        'SELECT id, code_hash FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL FOR UPDATE',
        [userId],
      );
      const hit = codes.rows.find(r => safeEqual(r.code_hash, hash));
      if (hit) {
        await db.query('UPDATE recovery_codes SET used_at = $2 WHERE id = $1', [hit.id, now]);
        ok = true;
      }
    }
    if (!ok) return { error: 'code' as const };
    await db.query('UPDATE mfa_challenges SET used_at = $2 WHERE token_hash = $1', [sha256(input.challengeToken), now]);
    await db.query('UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = $2 WHERE id = $1', [userId, now]);
    await db.query(`INSERT INTO auth_events (user_id, kind, ip, user_agent) VALUES ($1, 'login', $2, $3)`, [
      userId, meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null,
    ]);
    const roles = await db.query<{ role: Role }>('SELECT role FROM user_roles WHERE user_id = $1', [userId]);
    const staff = roles.rows.some(r => isStaffRole(r.role));
    const session = await createSession(db, config.csrfSecret, { userId, staff, mfaVerified: true, ip: meta.ip, userAgent: meta.userAgent, now });
    return { userId, session };
  });
  if ('error' in result) {
    throw result.error === 'expired'
      ? new AppError(401, 'auth.mfa_expired', 'This sign-in attempt has expired. Sign in again.')
      : new AppError(401, 'auth.mfa_invalid', 'That code is not right. Try the current code from your authenticator app.');
  }
  return result;
}
