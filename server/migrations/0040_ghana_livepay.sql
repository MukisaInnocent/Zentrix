-- Owner, 2026-11-11: Ghana pays and is paid through LivePay (the GHS wallet is active on the same LivePay account).
-- 1. A LivePay payment method for Ghana in GHS, with the same LivePay account as Uganda's (copied from it, so no
--    account details live in this file). Only where Uganda has one and Ghana has none yet.
-- 2. Ghana's withdrawals below its approval amount are paid automatically through LivePay (auto_payout), like Uganda.

-- Up Migration

INSERT INTO payment_channels (code, name, country_code, currency_code, account_name, account_number, provider, instructions)
SELECT 'livepay_gh', 'Mobile money (LivePay)', 'GH', 'GHS', ug.account_name, ug.account_number, 'livepay',
       'Approve the payment prompt on your phone with your mobile money PIN.'
FROM payment_channels ug
WHERE ug.provider = 'livepay' AND ug.country_code = 'UG' AND ug.removed_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM payment_channels gh WHERE gh.country_code = 'GH' AND gh.provider = 'livepay' AND gh.removed_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM payment_channels x WHERE x.code = 'livepay_gh')
ORDER BY ug.id
LIMIT 1;

INSERT INTO country_configs (country_code, version, currency_code, membership_fee_minor, withdrawal_min_minor, withdrawal_max_minor,
  withdrawal_daily_max_minor, withdrawal_fee_bp, withdrawal_fee_min_minor, withdrawal_approval_threshold_minor, new_account_review_days, vat_bp,
  kyc_level_for_withdrawal, engagement_tasks_enabled, terms_version, privacy_version, is_placeholder, note,
  referral_level1_minor, referral_level2_minor, referral_level3_minor, auto_payout, fee_currency_code, withdrawal_charge_bp)
SELECT country_code, version + 1, currency_code, membership_fee_minor, withdrawal_min_minor, withdrawal_max_minor,
  withdrawal_daily_max_minor, withdrawal_fee_bp, withdrawal_fee_min_minor, withdrawal_approval_threshold_minor, new_account_review_days, vat_bp,
  kyc_level_for_withdrawal, engagement_tasks_enabled, terms_version, privacy_version, is_placeholder,
  'Owner 2026-11-11: Ghana withdrawals below the approval amount are paid automatically through LivePay.',
  referral_level1_minor, referral_level2_minor, referral_level3_minor, true, fee_currency_code, withdrawal_charge_bp
FROM current_country_configs WHERE country_code = 'GH' AND NOT auto_payout;

-- Down Migration

SELECT 1;
