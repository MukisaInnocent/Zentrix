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
    fallback: { email: 'support@pexerearn.test', phone: '+256 700 000 000', hours: 'Mon to Fri, 09:00 to 17:00 EAT' },
    description: 'Support contact shown on the Contact page. TODO(owner): real details.',
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
