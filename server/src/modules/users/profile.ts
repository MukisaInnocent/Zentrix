import type { Db } from '../../db/sql.js';
import { maybeOne } from '../../db/sql.js';
import type { AuthContext, Role } from '../auth/context.js';
import { isStaffRole } from '../auth/context.js';

interface ProfileRow {
  public_id: string;
  username: string;
  email: string;
  email_verified_at: Date | null;
  phone_e164: string;
  phone_verified_at: Date | null;
  country_code: string;
  country_name: string;
  currency_code: string;
  locale: string;
  timezone: string;
  status: AuthContext['status'];
  referral_code: string;
  created_at: Date;
  referrer_username: string | null;
  mfa_enabled: boolean;
  roles: Role[];
}

export interface Profile {
  id: string;
  username: string;
  email: string;
  phone: string;
  emailVerified: boolean;
  phoneVerified: boolean;
  country: { code: string; name: string };
  currency: string;
  locale: string;
  timezone: string;
  status: AuthContext['status'];
  referralCode: string;
  referrer: { username: string } | null;
  roles: Role[];
  isStaff: boolean;
  mfaEnabled: boolean;
  createdAt: string;
}

export async function loadProfile(db: Db, userId: number): Promise<Profile | null> {
  const row = await maybeOne<ProfileRow>(
    db,
    `SELECT u.public_id, u.username, u.email, u.email_verified_at, u.phone_e164, u.phone_verified_at, u.country_code,
            c.name AS country_name, u.currency_code, u.locale, u.timezone, u.status, u.referral_code, u.created_at,
            ref.username AS referrer_username, t.enabled_at IS NOT NULL AS mfa_enabled,
            coalesce((SELECT array_agg(role ORDER BY role) FROM user_roles r WHERE r.user_id = u.id), '{}') AS roles
     FROM users u
     JOIN countries c ON c.code = u.country_code
     LEFT JOIN users ref ON ref.id = u.referred_by_user_id
     LEFT JOIN totp_credentials t ON t.user_id = u.id
     WHERE u.id = $1 AND u.anonymized_at IS NULL`,
    [userId],
  );
  if (!row) return null;
  return {
    id: row.public_id,
    username: row.username,
    email: row.email,
    phone: row.phone_e164,
    emailVerified: row.email_verified_at !== null,
    phoneVerified: row.phone_verified_at !== null,
    country: { code: row.country_code, name: row.country_name },
    currency: row.currency_code,
    locale: row.locale,
    timezone: row.timezone,
    status: row.status,
    referralCode: row.referral_code,
    referrer: row.referrer_username ? { username: row.referrer_username } : null,
    roles: row.roles,
    isStaff: row.roles.some(isStaffRole),
    mfaEnabled: row.mfa_enabled,
    createdAt: row.created_at.toISOString(),
  };
}
