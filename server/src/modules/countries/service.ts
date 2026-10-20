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
  withdrawalMonthlyMaxMinor: string;
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
  createdAt: Date;
}

interface ConfigRow {
  country_code: string; version: number; currency_code: string; membership_fee_minor: string; withdrawal_min_minor: string;
  withdrawal_max_minor: string; withdrawal_daily_max_minor: string; withdrawal_monthly_max_minor: string;
  withdrawal_fee_bp: number; withdrawal_fee_min_minor: string; withdrawal_approval_threshold_minor: string;
  new_account_review_days: number; vat_bp: number; kyc_level_for_withdrawal: number; engagement_tasks_enabled: boolean;
  terms_version: string; privacy_version: string; is_placeholder: boolean; created_at: Date;
}

export const toConfig = (r: ConfigRow): CountryConfig => ({
  countryCode: r.country_code, version: r.version, currencyCode: r.currency_code, membershipFeeMinor: r.membership_fee_minor,
  withdrawalMinMinor: r.withdrawal_min_minor, withdrawalMaxMinor: r.withdrawal_max_minor,
  withdrawalDailyMaxMinor: r.withdrawal_daily_max_minor, withdrawalMonthlyMaxMinor: r.withdrawal_monthly_max_minor,
  withdrawalFeeBp: r.withdrawal_fee_bp, withdrawalFeeMinMinor: r.withdrawal_fee_min_minor,
  withdrawalApprovalThresholdMinor: r.withdrawal_approval_threshold_minor, newAccountReviewDays: r.new_account_review_days,
  vatBp: r.vat_bp, kycLevelForWithdrawal: r.kyc_level_for_withdrawal, engagementTasksEnabled: r.engagement_tasks_enabled,
  termsVersion: r.terms_version, privacyVersion: r.privacy_version, isPlaceholder: r.is_placeholder, createdAt: r.created_at,
});

export async function currentCountryConfig(db: Db, code: string): Promise<CountryConfig | null> {
  const row = await maybeOne<ConfigRow>(db, 'SELECT * FROM current_country_configs WHERE country_code = $1', [code]);
  return row ? toConfig(row) : null;
}

export async function countryConfigHistory(db: Db, code: string): Promise<CountryConfig[]> {
  return (await rows<ConfigRow>(db, 'SELECT * FROM country_configs WHERE country_code = $1 ORDER BY version DESC', [code])).map(toConfig);
}
