import { parseInternational, PHONE_HELP } from '../../lib/phone.js';
import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';
import { badRequest, notFound, serviceUnavailable } from '../../lib/errors.js';

export interface Channel {
  id: number;
  code: string;
  name: string;
  countryCode: string;
  currency: string;
  accountName: string;
  accountNumber: string;
  instructions: string | null;
  ussdCode: string | null;
  merchantCode: string | null;
  depositsEnabled: boolean;
  payoutsEnabled: boolean;
  removedAt: Date | null;
}

interface ChannelRow {
  id: string; code: string; name: string; country_code: string; currency_code: string; account_name: string; account_number: string;
  instructions: string | null; ussd_code: string | null; merchant_code: string | null; deposits_enabled: boolean; payouts_enabled: boolean;
  removed_at: Date | null;
}

const toChannel = (r: ChannelRow): Channel => ({
  id: Number(r.id), code: r.code, name: r.name, countryCode: r.country_code, currency: r.currency_code, accountName: r.account_name,
  accountNumber: r.account_number, instructions: r.instructions, ussdCode: r.ussd_code, merchantCode: r.merchant_code, depositsEnabled: r.deposits_enabled, payoutsEnabled: r.payouts_enabled,
  removedAt: r.removed_at,
});

// Removed (archived) methods are left out unless asked for; only the staff console lists them.
export async function listChannels(db: Db, filter: { currency?: string; country?: string; includeRemoved?: boolean } = {}): Promise<Channel[]> {
  const list = await rows<ChannelRow>(
    db,
    `SELECT * FROM payment_channels WHERE ($1::char(3) IS NULL OR currency_code = $1) AND ($2::char(2) IS NULL OR country_code = $2)
       AND ($3 OR removed_at IS NULL)
     ORDER BY country_code, id`,
    [filter.currency ?? null, filter.country ?? null, filter.includeRemoved ?? false],
  );
  return list.map(toChannel);
}

export async function channelByCode(db: Db, code: string): Promise<Channel> {
  const row = await maybeOne<ChannelRow>(db, 'SELECT * FROM payment_channels WHERE code = $1', [code]);
  if (!row) throw notFound('payments.channel_not_found', 'That payment method is not available.');
  return toChannel(row);
}

// Channel details as members see them (no internal ids).
export const publicChannel = (c: Channel) => ({
  code: c.code, name: c.name, currency: c.currency, accountName: c.accountName, accountNumber: c.accountNumber, instructions: c.instructions,
  ussdCode: c.ussdCode, merchantCode: c.merchantCode,
  depositsEnabled: c.depositsEnabled, payoutsEnabled: c.payoutsEnabled,
});

export type FlagKey = 'deposits_paused' | 'withdrawals_paused';

export async function flagActive(db: Db, key: FlagKey, currency: string): Promise<{ active: boolean; reason: string | null }> {
  const row = await maybeOne<{ active: boolean; reason: string | null }>(
    db, 'SELECT active, reason FROM system_flags WHERE key = $1 AND currency_code = $2', [key, currency],
  );
  return { active: row?.active ?? false, reason: row?.reason ?? null };
}

export async function assertNotPaused(db: Db, key: FlagKey, currency: string): Promise<void> {
  if ((await flagActive(db, key, currency)).active) {
    throw serviceUnavailable(
      `payments.${key}`,
      key === 'deposits_paused' ? 'Deposits are paused for a short check. Please try again later.' : 'Withdrawals are paused for a short check. Please try again later.',
    );
  }
}

export async function setFlag(db: Db, key: FlagKey, currency: string, active: boolean, reason: string | null, actorId: number | null, automatic: boolean): Promise<void> {
  await db.query(
    `INSERT INTO system_flags (key, currency_code, active, automatic, reason, changed_by, changed_at) VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (key, currency_code) DO UPDATE SET active = EXCLUDED.active, automatic = EXCLUDED.automatic, reason = EXCLUDED.reason,
       changed_by = EXCLUDED.changed_by, changed_at = now()`,
    [key, currency, active, automatic, reason, actorId],
  );
}

// Names the actor and note for the status-history trigger (payment_events) for the rest of the transaction.
export async function setActor(db: Db, actorId: number, note?: string | null): Promise<void> {
  await db.query(`SELECT set_config('zentrix.actor_id', $1, true), set_config('zentrix.status_note', $2, true)`, [String(actorId), note ?? '']);
}

// The phone a payment was sent from: any valid number that starts with its country code.
export function normalizePhone(input: string): string {
  const phone = parseInternational(input);
  if (!phone) throw badRequest('validation_failed', `Enter a valid mobile number. ${PHONE_HELP}`, { senderPhone: [`Enter a valid mobile number. ${PHONE_HELP}`] });
  return phone.number;
}

// Mobile-money transaction IDs are compared in upper case without spaces.
export const normalizeTxnId = (value: string) => value.replace(/\s+/g, '').toUpperCase();

export async function exponentOf(db: Db, currency: string): Promise<number> {
  return (await one<{ exponent: number }>(db, 'SELECT exponent FROM currencies WHERE code = $1', [currency])).exponent;
}

export const PAGE = 25;
