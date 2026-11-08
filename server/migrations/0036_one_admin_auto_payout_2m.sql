-- Owner, 2026-11-08:
-- 1. Uganda's automatic withdrawals reach UGX 2,000,000: below that amount a withdrawal is approved and sent through
--    LivePay at once; from UGX 2,000,000 an admin approves. A new Uganda config version; everything else stays.
-- 2. Every approval is made by one admin: the same staff member may approve a withdrawal and send or record its payout,
--    and the admin who asks for a treasury transfer may approve it. (Staff still never handle their own money.)

-- Up Migration

INSERT INTO country_configs (country_code, version, currency_code, membership_fee_minor, withdrawal_min_minor, withdrawal_max_minor,
  withdrawal_daily_max_minor, withdrawal_fee_bp, withdrawal_fee_min_minor, withdrawal_approval_threshold_minor, new_account_review_days, vat_bp,
  kyc_level_for_withdrawal, engagement_tasks_enabled, terms_version, privacy_version, is_placeholder, note,
  referral_level1_minor, referral_level2_minor, referral_level3_minor, auto_payout, fee_currency_code, withdrawal_charge_bp)
SELECT country_code, version + 1, currency_code, membership_fee_minor, withdrawal_min_minor, withdrawal_max_minor,
  withdrawal_daily_max_minor, withdrawal_fee_bp, withdrawal_fee_min_minor, 2000000, new_account_review_days, vat_bp,
  kyc_level_for_withdrawal, engagement_tasks_enabled, terms_version, privacy_version, is_placeholder,
  'Owner 2026-11-08: automatic withdrawals below UGX 2,000,000.',
  referral_level1_minor, referral_level2_minor, referral_level3_minor, auto_payout, fee_currency_code, withdrawal_charge_bp
FROM current_country_configs WHERE country_code = 'UG' AND currency_code = 'UGX';

DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conrelid::regclass AS tbl, conname FROM pg_constraint
    WHERE contype = 'c' AND (
      (conrelid = 'withdrawals'::regclass AND pg_get_constraintdef(oid) LIKE '%paid_by <> approved_by%')
      OR (conrelid = 'treasury_requests'::regclass AND pg_get_constraintdef(oid) LIKE '%decided_by <> requested_by%'))
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
  END LOOP;
END
$$;

-- Down Migration

ALTER TABLE treasury_requests ADD CONSTRAINT treasury_requests_two_admins CHECK (decided_by IS NULL OR decided_by <> requested_by) NOT VALID;
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_two_people CHECK (NOT needs_two_people OR paid_by IS NULL OR paid_by <> approved_by) NOT VALID;
ALTER TABLE country_configs DISABLE TRIGGER country_configs_append_only;
DELETE FROM country_configs WHERE note = 'Owner 2026-11-08: automatic withdrawals below UGX 2,000,000.';
ALTER TABLE country_configs ENABLE TRIGGER country_configs_append_only;
