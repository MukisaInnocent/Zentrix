import type { Db } from '../../db/sql.js';
import { maybeOne, rows } from '../../db/sql.js';
import type { FxSnapshot } from '../../providers/fx.js';

// Stored exchange rates and conversion (owner, 2026-10-28: referral rewards across countries). Rates are units
// per US dollar; a cross rate divides one by the other. Conversion is exact integer arithmetic on minor units and
// rounds down, so a member is never credited more than the rate gives.

/** A rate older than this is not used; the conversion waits for the next refresh instead. */
export const FX_MAX_AGE_HOURS = 72;
const SCALE = 12; // fx_rates.units_per_usd is numeric(30, 12)

// Stores a snapshot's rates for the currencies we know. Returns how many rows were new.
export async function storeRates(db: Db, snapshot: FxSnapshot): Promise<number> {
  const codes = Object.keys(snapshot.unitsPerUsd);
  if (codes.length === 0) return 0;
  const inserted = await rows<{ id: string }>(
    db,
    `INSERT INTO fx_rates (currency_code, units_per_usd, source, rate_at)
     SELECT c.code, r.rate::numeric, $3, $4 FROM unnest($1::text[], $2::text[]) AS r(code, rate) JOIN currencies c ON c.code = r.code
     ON CONFLICT (currency_code, source, rate_at) DO NOTHING RETURNING id`,
    [codes, codes.map(c => snapshot.unitsPerUsd[c]), snapshot.source, snapshot.rateAt],
  );
  return inserted.length;
}

export interface Conversion {
  amountMinor: bigint;
  /** Units of the target currency per unit of the source currency. */
  rate: string;
  /** The older of the two rates used. */
  rateAt: Date;
}

const scaled = (text: string) => {
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole! + frac.padEnd(SCALE, '0').slice(0, SCALE));
};

// Converts minor units of `from` into minor units of `to` at the latest recent rates, or null when either
// currency has no rate younger than FX_MAX_AGE_HOURS.
export async function convert(db: Db, amountMinor: bigint, from: string, to: string): Promise<Conversion | null> {
  const row = await maybeOne<{ f_rate: string; f_exp: number; t_rate: string; t_exp: number; rate_at: Date; rate: string }>(
    db,
    `WITH latest AS (
       SELECT DISTINCT ON (r.currency_code) r.currency_code, r.units_per_usd, r.rate_at, c.exponent
       FROM fx_rates r JOIN currencies c ON c.code = r.currency_code
       WHERE r.currency_code IN ($1, $2) AND r.rate_at > now() - make_interval(hours => $3)
       ORDER BY r.currency_code, r.rate_at DESC, r.id DESC
     )
     SELECT f.units_per_usd::text AS f_rate, f.exponent AS f_exp, t.units_per_usd::text AS t_rate, t.exponent AS t_exp,
            least(f.rate_at, t.rate_at) AS rate_at, round(t.units_per_usd / f.units_per_usd, ${SCALE})::text AS rate
     FROM latest f, latest t WHERE f.currency_code = $1 AND t.currency_code = $2`,
    [from, to, FX_MAX_AGE_HOURS],
  );
  if (!row) return null;
  const numerator = amountMinor * scaled(row.t_rate) * 10n ** BigInt(row.t_exp);
  const denominator = scaled(row.f_rate) * 10n ** BigInt(row.f_exp);
  return { amountMinor: numerator / denominator, rate: row.rate, rateAt: row.rate_at };
}
