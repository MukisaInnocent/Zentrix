import type { Db } from '../../db/sql.js';
import { maybeOne, one } from '../../db/sql.js';
import { hmacSha256, randomToken, sha256 } from '../../lib/crypto.js';
import { isStaffRole, type AuthContext, type Role } from './context.js';

// Members: 7 days absolute, 24 h idle, new token every 12 h. Staff: 12 h absolute, 30 min idle, new token
// every hour. The previous token keeps working for 60 s so requests in flight during rotation succeed.
export const SESSION_POLICY = {
  member: { absoluteMs: 7 * 24 * 3_600_000, idleMs: 24 * 3_600_000, rotateMs: 12 * 3_600_000 },
  staff: { absoluteMs: 12 * 3_600_000, idleMs: 30 * 60_000, rotateMs: 3_600_000 },
  graceMs: 60_000,
  touchMs: 60_000,
} as const;

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function csrfTokenFor(secret: string, sessionId: number): string {
  return hmacSha256(secret, `csrf:${sessionId}`).toString('base64url');
}

export interface IssuedSession {
  sessionId: number;
  token: string;
  csrfToken: string;
  maxAgeMs: number;
}

export async function createSession(
  db: Db,
  csrfSecret: string,
  opts: { userId: number; staff: boolean; mfaVerified: boolean; ip: string | undefined; userAgent: string | undefined; now: Date },
): Promise<IssuedSession> {
  const policy = opts.staff ? SESSION_POLICY.staff : SESSION_POLICY.member;
  const token = randomToken(32);
  const now = opts.now.getTime();
  const row = await one<{ id: string }>(
    db,
    `INSERT INTO sessions (user_id, token_hash, created_at, last_seen_at, rotated_at, idle_expires_at, expires_at, mfa_verified_at, ip, user_agent)
     VALUES ($1, $2, $3, $3, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [opts.userId, sha256(token), opts.now, new Date(now + policy.idleMs), new Date(now + policy.absoluteMs),
      opts.mfaVerified ? opts.now : null, opts.ip ?? null, opts.userAgent?.slice(0, 300) ?? null],
  );
  const sessionId = Number(row.id);
  return { sessionId, token, csrfToken: csrfTokenFor(csrfSecret, sessionId), maxAgeMs: policy.absoluteMs };
}

interface SessionRow {
  id: string;
  user_id: string;
  matched_current: boolean;
  expires_at: Date;
  rotated_at: Date;
  last_seen_at: Date;
  mfa_verified_at: Date | null;
  public_id: string;
  username: string;
  status: AuthContext['status'];
  country_code: string;
  currency_code: string;
  email_verified: boolean;
  phone_verified: boolean;
  mfa_enabled: boolean;
  roles: Role[];
}

export interface LoadedSession {
  context: AuthContext;
  matchedCurrent: boolean;
  expiresAt: Date;
  rotatedAt: Date;
  lastSeenAt: Date;
}

export async function findSession(db: Db, csrfSecret: string, token: string, now: Date): Promise<LoadedSession | null> {
  const row = await maybeOne<SessionRow>(
    db,
    `SELECT s.id, s.user_id, s.token_hash = $1 AS matched_current, s.expires_at, s.rotated_at, s.last_seen_at, s.mfa_verified_at,
            u.public_id, u.username, u.status, u.country_code, u.currency_code,
            u.email_verified_at IS NOT NULL AS email_verified, u.phone_verified_at IS NOT NULL AS phone_verified,
            t.enabled_at IS NOT NULL AS mfa_enabled,
            coalesce((SELECT array_agg(role ORDER BY role) FROM user_roles r WHERE r.user_id = u.id), '{}') AS roles
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN totp_credentials t ON t.user_id = u.id
     WHERE (s.token_hash = $1 OR (s.previous_token_hash = $1 AND s.previous_valid_until > $2))
       AND s.revoked_at IS NULL AND s.expires_at > $2 AND s.idle_expires_at > $2 AND u.status <> 'closed'`,
    [sha256(token), now],
  );
  if (!row) return null;
  const sessionId = Number(row.id);
  const isStaff = row.roles.some(isStaffRole);
  return {
    matchedCurrent: row.matched_current,
    expiresAt: row.expires_at,
    rotatedAt: row.rotated_at,
    lastSeenAt: row.last_seen_at,
    context: {
      sessionId,
      userId: Number(row.user_id),
      publicId: row.public_id,
      username: row.username,
      roles: row.roles,
      isStaff,
      mfaEnabled: row.mfa_enabled,
      mfaVerified: row.mfa_verified_at !== null,
      status: row.status,
      countryCode: row.country_code,
      currencyCode: row.currency_code,
      emailVerified: row.email_verified,
      phoneVerified: row.phone_verified,
      csrfToken: csrfTokenFor(csrfSecret, sessionId),
    },
  };
}

export async function touchSession(db: Db, sessionId: number, staff: boolean, now: Date): Promise<void> {
  const idle = staff ? SESSION_POLICY.staff.idleMs : SESSION_POLICY.member.idleMs;
  await db.query(
    `UPDATE sessions SET last_seen_at = $2, idle_expires_at = least(expires_at, $3) WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId, now, new Date(now.getTime() + idle)],
  );
}

// Replaces the session token. Returns the new token, or null if another request rotated it first.
export async function rotateSession(db: Db, sessionId: number, now: Date, opts: { mfaVerified?: boolean } = {}): Promise<string | null> {
  const token = randomToken(32);
  const result = await db.query(
    `UPDATE sessions SET previous_token_hash = token_hash, previous_valid_until = $3, token_hash = $2, rotated_at = $4,
            mfa_verified_at = CASE WHEN $5 THEN $4 ELSE mfa_verified_at END
     WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId, sha256(token), new Date(now.getTime() + SESSION_POLICY.graceMs), now, opts.mfaVerified === true],
  );
  return result.rowCount === 1 ? token : null;
}

export async function revokeSession(db: Db, sessionId: number, reason: string): Promise<void> {
  await db.query(`UPDATE sessions SET revoked_at = now(), revoke_reason = $2 WHERE id = $1 AND revoked_at IS NULL`, [sessionId, reason]);
}

export async function revokeUserSessions(db: Db, userId: number, reason: string, exceptSessionId?: number): Promise<number> {
  const result = await db.query(
    `UPDATE sessions SET revoked_at = now(), revoke_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL AND id <> $3`,
    [userId, reason, exceptSessionId ?? 0],
  );
  return result.rowCount ?? 0;
}
