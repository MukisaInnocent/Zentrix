import type { Db } from '../../db/sql.js';
import { maybeOne, rows } from '../../db/sql.js';

export interface Country {
  code: string;
  name: string;
  currencyCode: string;
  dialCode: string;
  defaultLocale: string;
  defaultTimezone: string;
  blocked: boolean;
  liveEnabled: boolean;
}

interface CountryRow {
  code: string;
  name: string;
  currency_code: string;
  dial_code: string;
  default_locale: string;
  default_timezone: string;
  blocked: boolean;
  live_enabled: boolean;
}

const toCountry = (r: CountryRow): Country => ({
  code: r.code, name: r.name, currencyCode: r.currency_code, dialCode: r.dial_code, defaultLocale: r.default_locale,
  defaultTimezone: r.default_timezone, blocked: r.blocked, liveEnabled: r.live_enabled,
});

export async function getCountry(db: Db, code: string): Promise<Country | null> {
  const row = await maybeOne<CountryRow>(db, 'SELECT * FROM countries WHERE code = $1', [code]);
  return row ? toCountry(row) : null;
}

export async function listCountries(db: Db): Promise<Country[]> {
  return (await rows<CountryRow>(db, 'SELECT * FROM countries ORDER BY name')).map(toCountry);
}

// Whether a country may be chosen at sign-up: never if blocked; in live mode only if switched on.
export const countryOpen = (c: Country, mode: 'test' | 'live') => !c.blocked && (mode === 'test' || c.liveEnabled);

export interface CountryConfig {
  countryCode: string;
  version: number;
  currencyCode: string;
  membershipFeeMinor: string;
  withdrawalMinMinor: string;
  withdrawalMaxMinor: string;
  withdrawalDailyMaxMinor: string;
  withdrawalFeeBp: number;
  withdrawalFeeMinMinor: string;
  withdrawalApprovalThresholdMinor: string;
  newAccountReviewDays: number;
  vatBp: number;
  kycLevelForWithdrawal: number;
  engagementTasksEnabled: boolean;
  termsVersion: string;
  privacyVersion: string;
  isPlaceholder: boolean;
  // Referral rewards for levels 1 to 3 in this currency (owner, 2026-10-31); null = the UGX setting scaled by the fee.
  referralLevelsMinor: [string, string, string] | null;
  // Withdrawals below the approval threshold, from established accounts, are paid through LivePay without staff.
  autoPayout: boolean;
  // The activation fee and referral amounts are in this currency (owner, 2026-10-31: USD outside the owner's table).
  feeCurrency: string;
  // Withdrawal charge as basis points of the amount; 0 = the currency's charge table.
  withdrawalChargeBp: number;
  note: string | null;
  createdAt: Date;
}

interface ConfigRow {
  country_code: string; version: number; currency_code: string; membership_fee_minor: string; withdrawal_min_minor: string;
  withdrawal_max_minor: string; withdrawal_daily_max_minor: string;
  withdrawal_fee_bp: number; withdrawal_fee_min_minor: string; withdrawal_approval_threshold_minor: string;
  new_account_review_days: number; vat_bp: number; kyc_level_for_withdrawal: number; engagement_tasks_enabled: boolean;
  terms_version: string; privacy_version: string; is_placeholder: boolean; created_at: Date;
  referral_level1_minor: string | null; referral_level2_minor: string | null; referral_level3_minor: string | null; auto_payout: boolean; note: string | null;
  fee_currency_code: string | null; withdrawal_charge_bp: number;
}

export const toConfig = (r: ConfigRow): CountryConfig => ({
  countryCode: r.country_code, version: r.version, currencyCode: r.currency_code, membershipFeeMinor: r.membership_fee_minor,
  withdrawalMinMinor: r.withdrawal_min_minor, withdrawalMaxMinor: r.withdrawal_max_minor,
  withdrawalDailyMaxMinor: r.withdrawal_daily_max_minor,
  withdrawalFeeBp: r.withdrawal_fee_bp, withdrawalFeeMinMinor: r.withdrawal_fee_min_minor,
  withdrawalApprovalThresholdMinor: r.withdrawal_approval_threshold_minor, newAccountReviewDays: r.new_account_review_days,
  vatBp: r.vat_bp, kycLevelForWithdrawal: r.kyc_level_for_withdrawal, engagementTasksEnabled: r.engagement_tasks_enabled,
  termsVersion: r.terms_version, privacyVersion: r.privacy_version, isPlaceholder: r.is_placeholder,
  referralLevelsMinor: r.referral_level1_minor === null ? null : [r.referral_level1_minor, r.referral_level2_minor!, r.referral_level3_minor!],
  autoPayout: r.auto_payout, feeCurrency: r.fee_currency_code ?? r.currency_code, withdrawalChargeBp: r.withdrawal_charge_bp, note: r.note, createdAt: r.created_at,
});

export async function currentCountryConfig(db: Db, code: string): Promise<CountryConfig | null> {
  const row = await maybeOne<ConfigRow>(db, 'SELECT * FROM current_country_configs WHERE country_code = $1', [code]);
  return row ? toConfig(row) : null;
}

export async function countryConfigHistory(db: Db, code: string): Promise<CountryConfig[]> {
  return (await rows<ConfigRow>(db, 'SELECT * FROM country_configs WHERE country_code = $1 ORDER BY version DESC', [code])).map(toConfig);
}
