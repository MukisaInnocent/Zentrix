-- Owner, 2026-10-31 (later):
-- 1. Countries not in the owner's table pay the activation fee in USD (USD 10; referral rewards USD 4 / 2 / 1).
--    Only the activation fee is in USD: the member's balance, deposits and withdrawals stay in the home currency,
--    and rewards reach each inviter converted into their own currency at the latest rate. A config's fee, and its
--    referral amounts, are in fee_currency_code (NULL = the country's own currency).
-- 2. Every country without its own charge table pays a withdrawal charge of 3% of the amount (plus the 0.5% tax).
--    The percentage is per country and comes before the currency's charge table, so Chad, Gabon and the other
--    XAF countries pay 3% while Cameroon keeps the XAF table. Uganda, Kenya, Tanzania and Cameroon keep their tables.

-- Up Migration

DROP VIEW current_country_configs;
ALTER TABLE country_configs
  ADD COLUMN fee_currency_code char(3) REFERENCES currencies (code),
  ADD COLUMN withdrawal_charge_bp integer NOT NULL DEFAULT 0 CHECK (withdrawal_charge_bp BETWEEN 0 AND 5000);
COMMENT ON COLUMN country_configs.fee_currency_code IS 'Currency of the activation fee and referral amounts; NULL = the country currency.';
COMMENT ON COLUMN country_configs.withdrawal_charge_bp IS 'Withdrawal charge as basis points of the amount (300 = 3%); 0 = the currency charge table.';
CREATE VIEW current_country_configs AS
  SELECT DISTINCT ON (country_code) * FROM country_configs ORDER BY country_code, version DESC;

INSERT INTO country_configs (country_code, version, currency_code, membership_fee_minor, withdrawal_min_minor, withdrawal_max_minor,
  withdrawal_daily_max_minor, withdrawal_fee_bp, withdrawal_fee_min_minor, withdrawal_approval_threshold_minor, new_account_review_days, vat_bp,
  kyc_level_for_withdrawal, engagement_tasks_enabled, terms_version, privacy_version, is_placeholder, note,
  referral_level1_minor, referral_level2_minor, referral_level3_minor, auto_payout, fee_currency_code, withdrawal_charge_bp)
SELECT cfg.country_code, cfg.version + 1, cfg.currency_code,
  CASE WHEN listed THEN cfg.membership_fee_minor ELSE 1000 END,
  cfg.withdrawal_min_minor, cfg.withdrawal_max_minor, cfg.withdrawal_daily_max_minor, 50, cfg.withdrawal_fee_min_minor,
  cfg.withdrawal_approval_threshold_minor, cfg.new_account_review_days, cfg.vat_bp, cfg.kyc_level_for_withdrawal, cfg.engagement_tasks_enabled,
  cfg.terms_version, cfg.privacy_version, cfg.is_placeholder,
  CASE WHEN listed THEN 'Owner 2026-10-31: withdrawal charge 3% of the amount (no charge table).'
    ELSE 'Owner 2026-10-31: activation fee USD 10 (rewards USD 4 / 2 / 1); withdrawal charge 3%. Limits are placeholders (TODO(owner)).' END,
  CASE WHEN listed THEN cfg.referral_level1_minor ELSE 400 END,
  CASE WHEN listed THEN cfg.referral_level2_minor ELSE 200 END,
  CASE WHEN listed THEN cfg.referral_level3_minor ELSE 100 END,
  cfg.auto_payout,
  CASE WHEN listed THEN cfg.fee_currency_code ELSE 'USD' END,
  300
FROM (SELECT *, country_code IN ('KE', 'TZ', 'CD', 'MZ', 'SL', 'MW', 'BF', 'SN', 'RW', 'NG', 'ZA', 'ZM', 'GH', 'BW', 'CM') AS listed
      FROM current_country_configs) cfg
WHERE cfg.country_code NOT IN ('UG', 'KE', 'TZ', 'CM');

DO $$
BEGIN
  IF zx_app_role_exists() THEN
    GRANT SELECT ON current_country_configs TO zentrix_app;
  END IF;
END
$$;

-- Down Migration

DROP VIEW current_country_configs;
ALTER TABLE country_configs DISABLE TRIGGER country_configs_append_only;
DELETE FROM country_configs WHERE note LIKE 'Owner 2026-10-31: withdrawal charge 3%' OR note LIKE 'Owner 2026-10-31: activation fee USD 10%';
ALTER TABLE country_configs ENABLE TRIGGER country_configs_append_only;
ALTER TABLE country_configs DROP COLUMN withdrawal_charge_bp, DROP COLUMN fee_currency_code;
CREATE VIEW current_country_configs AS
  SELECT DISTINCT ON (country_code) * FROM country_configs ORDER BY country_code, version DESC;
DO $$
BEGIN
  IF zx_app_role_exists() THEN
    GRANT SELECT ON current_country_configs TO zentrix_app;
  END IF;
END
$$;
