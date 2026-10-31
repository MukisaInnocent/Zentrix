-- Owner, 2026-11-01: the withdrawal tax is 0.7% of the amount (was 0.5%), in every country. A new config version for
-- each country; everything else stays as it is.

-- Up Migration

INSERT INTO country_configs (country_code, version, currency_code, membership_fee_minor, withdrawal_min_minor, withdrawal_max_minor,
  withdrawal_daily_max_minor, withdrawal_fee_bp, withdrawal_fee_min_minor, withdrawal_approval_threshold_minor, new_account_review_days, vat_bp,
  kyc_level_for_withdrawal, engagement_tasks_enabled, terms_version, privacy_version, is_placeholder, note,
  referral_level1_minor, referral_level2_minor, referral_level3_minor, auto_payout, fee_currency_code, withdrawal_charge_bp)
SELECT country_code, version + 1, currency_code, membership_fee_minor, withdrawal_min_minor, withdrawal_max_minor,
  withdrawal_daily_max_minor, 70, withdrawal_fee_min_minor, withdrawal_approval_threshold_minor, new_account_review_days, vat_bp,
  kyc_level_for_withdrawal, engagement_tasks_enabled, terms_version, privacy_version, is_placeholder,
  'Owner 2026-11-01: withdrawal tax 0.7% of the amount.',
  referral_level1_minor, referral_level2_minor, referral_level3_minor, auto_payout, fee_currency_code, withdrawal_charge_bp
FROM current_country_configs;

-- Down Migration

ALTER TABLE country_configs DISABLE TRIGGER country_configs_append_only;
DELETE FROM country_configs WHERE note = 'Owner 2026-11-01: withdrawal tax 0.7% of the amount.';
ALTER TABLE country_configs ENABLE TRIGGER country_configs_append_only;
