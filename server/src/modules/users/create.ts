import { parseInternational } from '../../lib/phone.js';
import type { Db } from '../../db/sql.js';
import { maybeOne, one } from '../../db/sql.js';
import { randomCode } from '../../lib/crypto.js';
import { hashPassword } from '../auth/passwords.js';
import type { Role } from '../auth/context.js';
import { sealTotpSecret } from '../auth/totp.js';

export interface NewUser {
  username: string;
  email: string;
  phone: string;
  country: string;
  password: string;
  roles: Role[];
  verified: boolean;
  referrerId?: number | null;
  totpSecret?: string;
}

// Creates a ready-to-use account directly (seeds, the admin bootstrap CLI and tests). Member sign-up goes
// through register.ts instead, which applies every public-facing check.
export async function createUserDirect(db: Db, encryptionKey: Buffer, u: NewUser): Promise<{ id: number; publicId: string; referralCode: string }> {
  const phone = parseInternational(u.phone);
  if (!phone) throw new Error(`Invalid phone number for ${u.username}`);
  const country = await one<{ currency_code: string; default_locale: string; default_timezone: string }>(
    db, 'SELECT currency_code, default_locale, default_timezone FROM countries WHERE code = $1', [u.country],
  );
  let referralCode = randomCode(8);
  while (await maybeOne(db, 'SELECT 1 FROM users WHERE referral_code = $1', [referralCode])) referralCode = randomCode(8);
  const row = await one<{ id: string; public_id: string }>(
    db,
    `INSERT INTO users (username, email, phone_e164, password_hash, country_code, currency_code, locale, timezone,
       referral_code, referred_by_user_id, email_verified_at, phone_verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $11 THEN now() END, CASE WHEN $11 THEN now() END)
     RETURNING id, public_id`,
    [u.username, u.email.toLowerCase(), phone.number, await hashPassword(u.password), u.country, country.currency_code,
      country.default_locale, country.default_timezone, referralCode, u.referrerId ?? null, u.verified],
  );
  const id = Number(row.id);
  for (const role of u.roles) await db.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [id, role]);
  await db.query(
    `INSERT INTO consents (user_id, kind, version, accepted) VALUES ($1, 'terms', 'seed', true), ($1, 'privacy', 'seed', true), ($1, 'age_18_or_over', 'seed', true)`,
    [id],
  );
  if (u.totpSecret) {
    await db.query('INSERT INTO totp_credentials (user_id, secret_ciphertext, enabled_at) VALUES ($1, $2, now())', [id, sealTotpSecret(encryptionKey, u.totpSecret)]);
  }
  return { id, publicId: row.public_id, referralCode };
}
