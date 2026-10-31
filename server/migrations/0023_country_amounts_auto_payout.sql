-- Owner, 2026-10-31:
-- 1. Activation fees and referral rewards (levels 1 to 3) per country, from the owner's table. A country with its
--    own reward amounts uses them as they are; a country without them (Uganda, and every country not in the
--    table) keeps the `referral.tier_amounts_ugx` setting scaled by its fee, as before. The three rewards together
--    never exceed the country's activation fee, so a reward is always paid for by the activation it comes from.
-- 2. Kenya, Tanzania and Cameroon: minimum and maximum withdrawal and the charge table. The maximum is the top of
--    the owner's table. Kenya's table leaves KES 3,800 to 4,000 open; it pays the next band (KES 200).
-- 3. Uganda: withdrawals below the admin-approval amount (UGX 200,000) are paid automatically through LivePay;
--    from that amount, an admin approves first. Every other country stays manual (auto_payout off).
-- The 0.5% tax (withdrawal_fee_bp = 50) already applies in every country.

-- Up Migration

DROP VIEW current_country_configs;
ALTER TABLE country_configs
  ADD COLUMN referral_level1_minor bigint CHECK (referral_level1_minor >= 0),
  ADD COLUMN referral_level2_minor bigint CHECK (referral_level2_minor >= 0),
  ADD COLUMN referral_level3_minor bigint CHECK (referral_level3_minor >= 0),
  ADD COLUMN auto_payout boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT country_configs_referral_all_or_none CHECK (
    (referral_level1_minor IS NULL) = (referral_level2_minor IS NULL) AND (referral_level2_minor IS NULL) = (referral_level3_minor IS NULL)),
  ADD CONSTRAINT country_configs_referral_within_fee CHECK (
    referral_level1_minor IS NULL OR referral_level1_minor + referral_level2_minor + referral_level3_minor <= membership_fee_minor);
COMMENT ON COLUMN country_configs.referral_level1_minor IS 'Level 1 referral reward in this currency; NULL = the UGX setting scaled by the fee.';
COMMENT ON COLUMN country_configs.auto_payout IS 'Withdrawals below the approval threshold (and not from a new account) are paid through LivePay without staff.';
CREATE VIEW current_country_configs AS
  SELECT DISTINCT ON (country_code) * FROM country_configs ORDER BY country_code, version DESC;

INSERT INTO country_configs (country_code, version, currency_code, membership_fee_minor, withdrawal_min_minor, withdrawal_max_minor,
  withdrawal_daily_max_minor, withdrawal_fee_bp, withdrawal_fee_min_minor, withdrawal_approval_threshold_minor, new_account_review_days, vat_bp,
  kyc_level_for_withdrawal, engagement_tasks_enabled, terms_version, privacy_version, is_placeholder, note,
  referral_level1_minor, referral_level2_minor, referral_level3_minor, auto_payout)
-- Amounts in major units; each is multiplied by the currency exponent.
WITH a (code, fee, l1, l2, l3, wmin, wmax) AS (VALUES
  ('KE', 550, 300, 150, 50, 700::numeric, 15000::numeric),
  ('TZ', 15000, 5500, 3500, 1500, 20000, 67000),
  ('CD', 16000, 7000, 4000, 2000, NULL, NULL),
  ('MZ', 460, 200, 100, 50, NULL, NULL),
  ('SL', 150, 60, 35, 20, NULL, NULL),
  ('MW', 20000, 4000, 2500, 800, NULL, NULL),
  ('BF', 3500, 1700, 800, 500, NULL, NULL),
  ('SN', 3500, 1700, 800, 500, NULL, NULL),
  ('RW', 8000, 4000, 1200, 800, NULL, NULL),
  ('NG', 9000, 4000, 2000, 1000, NULL, NULL),
  ('ZA', 120, 60, 30, 10, NULL, NULL),
  ('ZM', 130, 50, 25, 15, NULL, NULL),
  ('GH', 95, 40, 25, 10, NULL, NULL),
  ('BW', 100, 30, 15, 7, NULL, NULL),
  ('CM', 3500, 1700, 800, 500, 4500, 30000))
SELECT cfg.country_code, cfg.version + 1, cfg.currency_code,
  (a.fee * power(10::numeric, k.exponent))::bigint,
  coalesce((a.wmin * power(10::numeric, k.exponent))::bigint, cfg.withdrawal_min_minor),
  coalesce((a.wmax * power(10::numeric, k.exponent))::bigint, cfg.withdrawal_max_minor),
  greatest(cfg.withdrawal_daily_max_minor, coalesce((a.wmax * power(10::numeric, k.exponent))::bigint, cfg.withdrawal_max_minor)),
  50, cfg.withdrawal_fee_min_minor, cfg.withdrawal_approval_threshold_minor, cfg.new_account_review_days, cfg.vat_bp,
  cfg.kyc_level_for_withdrawal, cfg.engagement_tasks_enabled, cfg.terms_version, cfg.privacy_version, true,
  CASE WHEN a.wmin IS NULL
    THEN 'Owner amounts 2026-10-31: activation fee and referral rewards. Withdrawal limits are still placeholders (TODO(owner)).'
    ELSE 'Owner amounts 2026-10-31: activation fee, referral rewards, withdrawal limits and charges. Approval amount is a placeholder (TODO(owner)).' END,
  (a.l1 * power(10::numeric, k.exponent))::bigint, (a.l2 * power(10::numeric, k.exponent))::bigint, (a.l3 * power(10::numeric, k.exponent))::bigint,
  false
FROM a
JOIN current_country_configs cfg ON cfg.country_code = a.code
JOIN currencies k ON k.code = cfg.currency_code;

DO $$
BEGIN
  IF (SELECT count(*) FROM country_configs WHERE note LIKE 'Owner amounts 2026-10-31:%') <> 15 THEN
    RAISE EXCEPTION 'a country in the owner''s table has no configuration to build on';
  END IF;
END
$$;

-- Uganda: automatic LivePay payouts below the approval amount (UGX 200,000).
INSERT INTO country_configs (country_code, version, currency_code, membership_fee_minor, withdrawal_min_minor, withdrawal_max_minor,
  withdrawal_daily_max_minor, withdrawal_fee_bp, withdrawal_fee_min_minor, withdrawal_approval_threshold_minor, new_account_review_days, vat_bp,
  kyc_level_for_withdrawal, engagement_tasks_enabled, terms_version, privacy_version, is_placeholder, note,
  referral_level1_minor, referral_level2_minor, referral_level3_minor, auto_payout)
SELECT country_code, version + 1, currency_code, membership_fee_minor, withdrawal_min_minor, withdrawal_max_minor,
  withdrawal_daily_max_minor, withdrawal_fee_bp, withdrawal_fee_min_minor, withdrawal_approval_threshold_minor, new_account_review_days, vat_bp,
  kyc_level_for_withdrawal, engagement_tasks_enabled, terms_version, privacy_version, is_placeholder,
  'Owner 2026-10-31: withdrawals below the approval amount are paid automatically through LivePay.',
  referral_level1_minor, referral_level2_minor, referral_level3_minor, true
FROM current_country_configs WHERE country_code = 'UG';

-- Charge tables (an amount up to and including up_to pays that band's charge).
INSERT INTO withdrawal_charges (currency_code, up_to_minor, charge_minor) VALUES
  ('KES', 120000, 11000), ('KES', 220000, 16000), ('KES', 380000, 18000), ('KES', 800000, 20000), ('KES', 1500000, 30000),
  ('TZS', 3000000, 100000), ('TZS', 4500000, 150000), ('TZS', 5500000, 185000), ('TZS', 6700000, 225000),
  ('XAF', 7000, 800), ('XAF', 15000, 950), ('XAF', 30000, 1290)
ON CONFLICT (currency_code, up_to_minor) DO UPDATE SET charge_minor = EXCLUDED.charge_minor;

DO $$
BEGIN
  IF zx_app_role_exists() THEN
    GRANT SELECT ON current_country_configs TO zentrix_app;
  END IF;
END
$$;

-- Down Migration

DELETE FROM withdrawal_charges WHERE currency_code IN ('KES', 'TZS', 'XAF');
DROP VIEW current_country_configs;
-- country_configs is append-only; the trigger is lifted only to remove this migration's own versions.
ALTER TABLE country_configs DISABLE TRIGGER country_configs_append_only;
DELETE FROM country_configs WHERE note LIKE 'Owner amounts 2026-10-31:%' OR note LIKE 'Owner 2026-10-31: withdrawals below%';
ALTER TABLE country_configs ENABLE TRIGGER country_configs_append_only;
ALTER TABLE country_configs
  DROP CONSTRAINT country_configs_referral_within_fee,
  DROP CONSTRAINT country_configs_referral_all_or_none,
  DROP COLUMN auto_payout,
  DROP COLUMN referral_level3_minor,
  DROP COLUMN referral_level2_minor,
  DROP COLUMN referral_level1_minor;
CREATE VIEW current_country_configs AS
  SELECT DISTINCT ON (country_code) * FROM country_configs ORDER BY country_code, version DESC;
DO $$
BEGIN
  IF zx_app_role_exists() THEN
    GRANT SELECT ON current_country_configs TO zentrix_app;
  END IF;
END
$$;
