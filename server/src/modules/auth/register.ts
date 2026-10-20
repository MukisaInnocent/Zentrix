import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';
import { z } from 'zod';
import { maybeOne, one } from '../../db/sql.js';
import { withTransaction } from '../../db/tx.js';
import { parse } from '../../http/validate.js';
import { randomCode } from '../../lib/crypto.js';
import { AppError, badRequest, conflict, DB_ERRORS, pgErrorCode } from '../../lib/errors.js';
import type { Services } from '../../services.js';
import { countryOpen, currentCountryConfig, getCountry } from '../countries/service.js';
import { raiseFlag } from '../fraud/flags.js';
import { getSetting } from '../settings/registry.js';
import { hashPassword, passwordProblems } from './passwords.js';
import { createSession, type IssuedSession } from './sessions.js';
import { issueEmailVerification, issuePhoneCode, sendEmailVerification, sendPhoneCode } from './verification.js';

export const RegisterSchema = z.strictObject({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_]{3,30}$/, { error: 'Use 3 to 30 letters, numbers or underscores.' }),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email({ error: 'Enter a valid email address.' })),
  password: z.string().max(256),
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, { error: 'Choose your country.' }),
  phone: z.string().trim().min(4, { error: 'Enter your mobile number.' }).max(32),
  dateOfBirth: z.iso.date({ error: 'Enter your date of birth.' }),
  timezone: z.string().trim().max(64).optional(),
  referralCode: z.string().trim().toUpperCase().max(16).optional(),
  acceptTerms: z.literal(true, { error: 'You must accept the Terms to continue.' }),
  acceptPrivacy: z.literal(true, { error: 'You must accept the Privacy notice to continue.' }),
});
export type RegisterInput = z.output<typeof RegisterSchema>;

export interface RequestMeta {
  ip: string | undefined;
  userAgent: string | undefined;
  geoCountry: string | null;
}

export function ageOn(dateOfBirth: string, today: Date): number {
  const [y, m, d] = dateOfBirth.split('-').map(Number) as [number, number, number];
  let age = today.getUTCFullYear() - y;
  const beforeBirthday = today.getUTCMonth() + 1 < m || (today.getUTCMonth() + 1 === m && today.getUTCDate() < d);
  if (beforeBirthday) age -= 1;
  return age;
}

export function validTimezone(tz: string | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const field = (name: string, message: string) => badRequest('validation_failed', message, { [name]: [message] });

export interface Registration {
  userId: number;
  session: IssuedSession;
}

export async function register(services: Services, raw: unknown, meta: RequestMeta): Promise<Registration> {
  const input = parse(RegisterSchema, raw);
  const { pool, config } = services;
  const now = services.now();

  const country = await getCountry(pool, input.country);
  if (!country || !countryOpen(country, config.appMode)) {
    throw field('country', 'Sign-up is not available in that country.');
  }
  const phone = parsePhoneNumberFromString(input.phone, country.code as CountryCode);
  if (!phone?.isValid()) throw field('phone', 'Enter a valid mobile number, including the area or network code.');
  const phoneType = phone.getType();
  if (phoneType !== undefined && phoneType !== 'MOBILE' && phoneType !== 'FIXED_LINE_OR_MOBILE') {
    throw field('phone', 'Use a mobile number. Payouts go to this number.');
  }
  const problems = passwordProblems(input.password, { username: input.username, email: input.email });
  if (problems.length > 0) throw badRequest('validation_failed', problems[0] ?? 'Choose a stronger password.', { password: problems });
  const dob = input.dateOfBirth;
  if (dob < '1900-01-01' || ageOn(dob, now) < 18) throw field('dateOfBirth', 'You must be 18 or older to join Zentrix.');

  const config_ = await currentCountryConfig(pool, country.code);
  const termsVersion = config_?.termsVersion ?? (await getSetting(pool, 'legal.terms_version'));
  const privacyVersion = config_?.privacyVersion ?? (await getSetting(pool, 'legal.privacy_version'));
  const timezone = validTimezone(input.timezone) ? input.timezone : country.defaultTimezone;
  const passwordHash = await hashPassword(input.password);

  let registration: Registration & { email: string; emailToken: string; phoneE164: string; phoneCode: string };
  try {
    registration = await withTransaction(pool, async db => {
      let referrerId: number | null = null;
      if (input.referralCode) {
        const ref = await maybeOne<{ id: string }>(
          db,
          `SELECT id FROM users WHERE referral_code = $1 AND status = 'active' AND anonymized_at IS NULL`,
          [input.referralCode],
        );
        if (!ref) throw field('referralCode', 'That referral code was not found. Check it or leave it empty.');
        referrerId = Number(ref.id);
      }
      let referralCode = randomCode(8);
      while (await maybeOne(db, 'SELECT 1 FROM users WHERE referral_code = $1', [referralCode])) referralCode = randomCode(8);

      const user = await one<{ id: string }>(
        db,
        `INSERT INTO users (username, email, phone_e164, password_hash, country_code, currency_code, locale, timezone,
           date_of_birth, referral_code, referred_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [input.username, input.email, phone.number, passwordHash, country.code, country.currencyCode,
          country.defaultLocale, timezone, dob, referralCode, referrerId],
      );
      const userId = Number(user.id);
      await db.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'member')`, [userId]);
      await db.query(
        `INSERT INTO consents (user_id, kind, version, accepted, ip) VALUES
           ($1, 'terms', $2, true, $4), ($1, 'privacy', $3, true, $4), ($1, 'age_18_or_over', 'dob-v1', true, $4)`,
        [userId, termsVersion, privacyVersion, meta.ip ?? null],
      );
      await db.query(`INSERT INTO auth_events (user_id, kind, ip, user_agent) VALUES ($1, 'signup', $2, $3)`, [
        userId, meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null,
      ]);

      // Mismatches and velocity are flagged for review, not blocked (section 1).
      if (phone.country && phone.country !== country.code) {
        await raiseFlag(db, userId, 'phone_country_mismatch', 'medium', { selected: country.code, phone: phone.country });
      }
      if (meta.geoCountry && meta.geoCountry !== country.code) {
        await raiseFlag(db, userId, 'ip_country_mismatch', 'low', { selected: country.code, ip: meta.geoCountry });
      }
      if (meta.ip) {
        const recent = await one<{ n: string }>(
          db,
          `SELECT count(*) AS n FROM auth_events WHERE kind = 'signup' AND ip = $1 AND created_at > now() - interval '24 hours'`,
          [meta.ip],
        );
        if (Number(recent.n) > 3) await raiseFlag(db, userId, 'signup_velocity', 'medium', { signupsFromIpIn24h: Number(recent.n) });
      }

      const emailToken = await issueEmailVerification(db, userId, input.email, now);
      const phoneCode = await issuePhoneCode(db, config.dataEncryptionKey, userId, phone.number, now);
      const session = await createSession(db, config.csrfSecret, {
        userId, staff: false, mfaVerified: false, ip: meta.ip, userAgent: meta.userAgent, now,
      });
      return { userId, session, email: input.email, emailToken, phoneE164: phone.number, phoneCode };
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (pgErrorCode(err) === DB_ERRORS.uniqueViolation) {
      const constraint = (err as { constraint?: string }).constraint ?? '';
      if (constraint.includes('username')) throw conflict('auth.username_taken', 'That username is taken. Choose another.');
      throw conflict(
        'auth.registration_conflict',
        'We could not create an account with those details. If you already have an account, sign in or reset your password.',
      );
    }
    throw err;
  }

  await sendEmailVerification(services, registration.email, registration.emailToken);
  await sendPhoneCode(services, registration.phoneE164, registration.phoneCode);
  return { userId: registration.userId, session: registration.session };
}
