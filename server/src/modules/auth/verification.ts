import { maybeOne } from '../../db/sql.js';
import type { Db } from '../../db/sql.js';
import { withTransaction } from '../../db/tx.js';
import { randomDigits, randomToken, safeEqual, sha256 } from '../../lib/crypto.js';
import { badRequest } from '../../lib/errors.js';
import type { Services } from '../../services.js';
import { codeHash } from './totp.js';

const EMAIL_TTL_MS = 48 * 3_600_000;
const PHONE_TTL_MS = 10 * 60_000;
const PHONE_MAX_ATTEMPTS = 5;

const testNote = (services: Services) => (services.config.appMode === 'test' ? '\n\nTEST MODE: no real money.' : '');

export async function issueEmailVerification(db: Db, userId: number, email: string, now: Date): Promise<string> {
  const token = randomToken(32);
  await db.query('UPDATE email_verifications SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL', [userId, now]);
  await db.query('INSERT INTO email_verifications (token_hash, user_id, email, expires_at) VALUES ($1, $2, $3, $4)', [
    sha256(token), userId, email, new Date(now.getTime() + EMAIL_TTL_MS),
  ]);
  return token;
}

// Messages go out after the transaction commits. A failed send is logged, not fatal: the member can
// ask for another message.
export async function sendEmailVerification(services: Services, email: string, token: string): Promise<void> {
  const link = `${services.config.publicOrigin}/verify.html#email=${token}`;
  try {
    await services.mailer.send({
      to: email,
      subject: 'Confirm your Pexerearn email address',
      text: `Confirm your email address by opening this link within 48 hours:\n\n${link}\n\nIf you did not create a Pexerearn account, ignore this email.${testNote(services)}`,
    });
  } catch (err) {
    services.logger.error({ err }, 'email verification send failed');
  }
}

export async function issuePhoneCode(db: Db, key: Buffer, userId: number, phone: string, now: Date): Promise<string> {
  const code = randomDigits(6);
  await db.query('UPDATE phone_verifications SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL', [userId, now]);
  await db.query('INSERT INTO phone_verifications (user_id, phone_e164, code_hash, expires_at) VALUES ($1, $2, $3, $4)', [
    userId, phone, codeHash(key, 'phone-otp', `${userId}:${code}`), new Date(now.getTime() + PHONE_TTL_MS),
  ]);
  return code;
}

export async function sendPhoneCode(services: Services, phone: string, code: string): Promise<void> {
  try {
    await services.sms.send(phone, `Your Pexerearn code is ${code}. It expires in 10 minutes. Never share it.`);
  } catch (err) {
    services.logger.error({ err }, 'phone code send failed');
  }
}

const invalidLink = () => badRequest('verify.invalid_link', 'This link is invalid or has expired. Ask for a new one from your profile.');

export async function verifyEmailToken(services: Services, token: string): Promise<void> {
  await withTransaction(services.pool, async db => {
    const row = await maybeOne<{ user_id: string; email: string }>(
      db,
      `SELECT v.user_id, v.email FROM email_verifications v JOIN users u ON u.id = v.user_id
       WHERE v.token_hash = $1 AND v.used_at IS NULL AND v.expires_at > $2 AND u.email = v.email FOR UPDATE OF v`,
      [sha256(token), services.now()],
    );
    if (!row) throw invalidLink();
    await db.query('UPDATE email_verifications SET used_at = $2 WHERE token_hash = $1', [sha256(token), services.now()]);
    await db.query('UPDATE users SET email_verified_at = coalesce(email_verified_at, $2) WHERE id = $1', [row.user_id, services.now()]);
    await db.query(`INSERT INTO auth_events (user_id, kind) VALUES ($1, 'email_verified')`, [row.user_id]);
  });
}

export async function verifyPhoneCode(services: Services, userId: number, code: string): Promise<void> {
  const ok = await withTransaction(services.pool, async db => {
    const row = await maybeOne<{ id: string; code_hash: Buffer; attempts: number; phone_e164: string }>(
      db,
      `SELECT p.id, p.code_hash, p.attempts, p.phone_e164 FROM phone_verifications p JOIN users u ON u.id = p.user_id
       WHERE p.user_id = $1 AND p.used_at IS NULL AND p.expires_at > $2 AND u.phone_e164 = p.phone_e164
       ORDER BY p.created_at DESC LIMIT 1 FOR UPDATE OF p`,
      [userId, services.now()],
    );
    if (!row || row.attempts >= PHONE_MAX_ATTEMPTS) return false;
    const match = /^[0-9]{6}$/.test(code) && safeEqual(row.code_hash, codeHash(services.config.dataEncryptionKey, 'phone-otp', `${userId}:${code}`));
    if (!match) {
      await db.query('UPDATE phone_verifications SET attempts = attempts + 1 WHERE id = $1', [row.id]);
      return false;
    }
    await db.query('UPDATE phone_verifications SET used_at = $2 WHERE id = $1', [row.id, services.now()]);
    await db.query('UPDATE users SET phone_verified_at = coalesce(phone_verified_at, $2) WHERE id = $1', [userId, services.now()]);
    await db.query(`INSERT INTO auth_events (user_id, kind) VALUES ($1, 'phone_verified')`, [userId]);
    return true;
  });
  if (!ok) throw badRequest('verify.code_invalid', 'That code is wrong or has expired. Ask for a new code.');
}
