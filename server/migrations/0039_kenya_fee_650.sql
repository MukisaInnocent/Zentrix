-- Owner, 2026-11-11: no country's activation fee is below UGX 19,000 (about KES 602 today). Kenya's fee is KES 650
-- (the owner's payment guide). A new config version for Kenya; everything else stays as it is.

-- Up Migration

INSERT INTO country_configs (country_code, version, currency_code, membership_fee_minor, withdrawal_min_minor, withdrawal_max_minor,
  withdrawal_daily_max_minor, withdrawal_fee_bp, withdrawal_fee_min_minor, withdrawal_approval_threshold_minor, new_account_review_days, vat_bp,
  kyc_level_for_withdrawal, engagement_tasks_enabled, terms_version, privacy_version, is_placeholder, note,
  referral_level1_minor, referral_level2_minor, referral_level3_minor, auto_payout, fee_currency_code, withdrawal_charge_bp)
SELECT country_code, version + 1, currency_code, 65000, withdrawal_min_minor, withdrawal_max_minor,
  withdrawal_daily_max_minor, withdrawal_fee_bp, withdrawal_fee_min_minor, withdrawal_approval_threshold_minor, new_account_review_days, vat_bp,
  kyc_level_for_withdrawal, engagement_tasks_enabled, terms_version, privacy_version, is_placeholder,
  'Owner 2026-11-11: activation fee KES 650 (no country below UGX 19,000).',
  -- The country reward amounts are no longer paid (2026-11-10) and must stay within the fee; cleared.
  NULL, NULL, NULL, auto_payout, fee_currency_code, withdrawal_charge_bp
FROM current_country_configs WHERE country_code = 'KE' AND currency_code = 'KES';

-- Down Migration

SELECT 1;
