import { z } from 'zod';
import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';
import { parse } from '../../http/validate.js';

// Every global setting has a schema and a fallback. Values are versioned rows in `settings`; the newest
// valid version applies. Fallbacks marked TODO(owner) are placeholders until the owner confirms them.
export const SETTING_DEFS = {
  'legal.terms_version': {
    schema: z.string().min(1).max(40),
    fallback: '2026-10-v1',
    description: 'Version of the Terms members accept at sign-up when the country has no config.',
  },
  'legal.privacy_version': {
    schema: z.string().min(1).max(40),
    fallback: '2026-10-v1',
    description: 'Version of the Privacy notice members accept at sign-up when the country has no config.',
  },
  'support.contact': {
    schema: z.strictObject({ email: z.email(), phone: z.string().min(5).max(30), hours: z.string().min(1).max(80) }),
    fallback: { email: 'info@pexerearn.com', phone: '+256 700 000 000', hours: 'Mon to Fri, 09:00 to 17:00 EAT' },
    description: 'Support contact shown on the Contact page. TODO(owner): real details.',
  },
  // Referral rewards for levels 1 to 3 (owner's amounts as the fallback), in Uganda shillings. Other countries get
  // the same share of their own activation fee. Together they stay within the UGX 19,000 fee, so a reward can
  // never cost more than the activation it pays for.
  'referral.tier_amounts_ugx': {
    schema: z.strictObject({
      level1: z.int().min(0).max(19_000),
      level2: z.int().min(0).max(19_000),
      level3: z.int().min(0).max(19_000),
    }).refine(t => t.level1 + t.level2 + t.level3 <= 19_000, { error: 'The three rewards together must not exceed the UGX 19,000 activation fee.' }),
    fallback: { level1: 10_000, level2: 5_000, level3: 2_000 },
    description: 'Referral rewards in UGX for levels 1, 2 and 3, paid when the invited member activates. Other countries get the same share of their fee.',
  },
  // Voucher value choices, as multiples of the buyer's activation fee (never below the fee).
  'voucher.value_multiples': {
    schema: z.array(z.int().min(1).max(20)).min(1).max(8)
      .refine(list => list.every((v, i) => i === 0 || v > list[i - 1]!), { error: 'List the multiples from smallest to largest, without repeats.' }),
    fallback: [1, 2, 3, 5],
    description: 'Voucher values members can buy, as multiples of the activation fee (1 = exactly the fee).',
  },
  // The email provider's allowance (Resend free plan: 100 a day, 3,000 a month). Announcements use only what is
  // left after keeping `reserved` of each day free for members' own emails (sign-up, payments, rewards).
  'email.allowance': {
    schema: z.strictObject({
      daily: z.int().min(1).max(1_000_000),
      monthly: z.int().min(1).max(10_000_000),
      reserved: z.int().min(0).max(1_000_000),
    }).refine(a => a.reserved < a.daily, { error: 'Keep the reserved number below the daily allowance.' }),
    fallback: { daily: 100, monthly: 3_000, reserved: 40 },
    description: 'Emails the provider allows per day and per month, and how many of each day stay free for the emails members need (sign-up, payments, rewards). Announcements use the rest.',
  },
  'community.url': {
    schema: z.url({ protocol: /^https$/ }).nullable(),
    fallback: null,
    description: 'Optional community channel link shown on the dashboard. TODO(owner).',
  },
} as const;

export type SettingKey = keyof typeof SETTING_DEFS;
export type SettingValue<K extends SettingKey> = z.output<(typeof SETTING_DEFS)[K]['schema']>;
export const isSettingKey = (key: string): key is SettingKey => Object.hasOwn(SETTING_DEFS, key);

export async function getSetting<K extends SettingKey>(db: Db, key: K): Promise<SettingValue<K>> {
  const def = SETTING_DEFS[key];
  const row = await maybeOne<{ value: unknown }>(db, 'SELECT value FROM current_settings WHERE key = $1', [key]);
  if (!row) return def.fallback as SettingValue<K>;
  const parsed = def.schema.safeParse(row.value);
  return (parsed.success ? parsed.data : def.fallback) as SettingValue<K>;
}

export async function setSetting<K extends SettingKey>(
  db: Db, key: K, value: unknown, actorUserId: number | null, note: string | null,
): Promise<{ version: number; value: SettingValue<K> }> {
  const valid = parse(SETTING_DEFS[key].schema, value) as SettingValue<K>;
  const row = await one<{ version: number }>(
    db,
    `INSERT INTO settings (key, value, version, note, created_by)
     SELECT $1, $2, coalesce(max(version), 0) + 1, $3, $4 FROM settings WHERE key = $1
     RETURNING version`,
    [key, JSON.stringify(valid), note, actorUserId],
  );
  return { version: row.version, value: valid };
}

export async function listSettings(db: Db) {
  const current = new Map(
    (await rows<{ key: string; value: unknown; version: number; created_at: Date }>(db, 'SELECT key, value, version, created_at FROM current_settings')).map(r => [r.key, r]),
  );
  return (Object.keys(SETTING_DEFS) as SettingKey[]).map(key => {
    const row = current.get(key);
    return {
      key,
      description: SETTING_DEFS[key].description,
      value: row ? row.value : SETTING_DEFS[key].fallback,
      version: row?.version ?? 0,
      isFallback: !row,
      updatedAt: row?.created_at ?? null,
    };
  });
}
