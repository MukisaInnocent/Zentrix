-- Owner, 2026-10-26:
-- 1. Deposited money is kept apart from the balance. A member's balance (member_main) holds referral rewards
--    only; confirmed wallet deposits, Pay For Client money received and voucher value above the activation fee
--    go to a new deposit balance (member_deposit).
-- 2. Withdrawals pay a fixed charge from a table by amount, plus a 0.5% tax on the amount (withdrawal_fee_bp).
--    Uganda: minimum UGX 15,000, maximum UGX 5,000,000 per withdrawal.

-- Up Migration

DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'accounts'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%member_withdrawal_hold%' LOOP
    EXECUTE format('ALTER TABLE accounts DROP CONSTRAINT %I', c);
  END LOOP;
END
$$;
ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check CHECK (kind IN ('member_main', 'member_deposit', 'member_task', 'member_withdrawal_hold',
  'payment_clearing', 'platform_revenue', 'fees', 'referral_budget', 'promotions_budget', 'owner_capital', 'suspense', 'voucher_liability', 'fx_clearing'));
ALTER TABLE accounts ADD CONSTRAINT accounts_member_check CHECK ((kind IN ('member_main', 'member_deposit', 'member_task', 'member_withdrawal_hold')) = (user_id IS NOT NULL));

-- The fixed withdrawal charge: an amount up to and including up_to_minor pays charge_minor (the smallest band
-- that fits). Amounts on a band boundary pay the lower band, as in the owner's table.
CREATE TABLE withdrawal_charges (
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  up_to_minor bigint NOT NULL CHECK (up_to_minor > 0),
  charge_minor bigint NOT NULL CHECK (charge_minor >= 0),
  PRIMARY KEY (currency_code, up_to_minor)
);

INSERT INTO withdrawal_charges (currency_code, up_to_minor, charge_minor) VALUES
  ('UGX', 50000, 1500), ('UGX', 100000, 2000), ('UGX', 150000, 2250), ('UGX', 200000, 2500), ('UGX', 250000, 2700),
  ('UGX', 300000, 3000), ('UGX', 350000, 3300), ('UGX', 400000, 3500), ('UGX', 500000, 4000), ('UGX', 600000, 4500),
  ('UGX', 700000, 5000), ('UGX', 850000, 5700), ('UGX', 950000, 6250), ('UGX', 1100000, 7000), ('UGX', 1500000, 9400),
  ('UGX', 3000000, 17000), ('UGX', 5000000, 26500);

-- Uganda: UGX 15,000 to 5,000,000 per withdrawal, 0.5% tax on top of the charge. The daily maximum rises to the
-- per-withdrawal maximum so the top band can be used (TODO(owner): confirm daily and monthly maximums).
INSERT INTO country_configs (country_code, version, currency_code, membership_fee_minor, withdrawal_min_minor, withdrawal_max_minor,
  withdrawal_daily_max_minor, withdrawal_monthly_max_minor, withdrawal_fee_bp, withdrawal_fee_min_minor, withdrawal_approval_threshold_minor,
  new_account_review_days, vat_bp, kyc_level_for_withdrawal, engagement_tasks_enabled, terms_version, privacy_version, is_placeholder, note)
SELECT country_code, version + 1, currency_code, membership_fee_minor, 15000, 5000000,
  greatest(withdrawal_daily_max_minor, 5000000), greatest(withdrawal_monthly_max_minor, 10000000), 50, 0, withdrawal_approval_threshold_minor,
  new_account_review_days, vat_bp, kyc_level_for_withdrawal, engagement_tasks_enabled, terms_version, privacy_version, is_placeholder,
  'Withdrawals UGX 15,000 to 5,000,000, charge table plus 0.5% tax (owner, 2026-10-26).'
FROM current_country_configs WHERE country_code = 'UG';

DO $$
BEGIN
  IF zx_app_role_exists() THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON withdrawal_charges FROM zentrix_app;
    GRANT SELECT ON withdrawal_charges TO zentrix_app;
  END IF;
END
$$;

-- Down Migration

DELETE FROM country_configs WHERE country_code = 'UG' AND note LIKE 'Withdrawals UGX 15,000 to 5,000,000%';
DROP TABLE withdrawal_charges;
ALTER TABLE accounts DROP CONSTRAINT accounts_member_check;
ALTER TABLE accounts DROP CONSTRAINT accounts_kind_check;
ALTER TABLE accounts ADD CHECK (kind IN ('member_main', 'member_task', 'member_withdrawal_hold', 'payment_clearing', 'platform_revenue',
  'fees', 'referral_budget', 'promotions_budget', 'owner_capital', 'suspense', 'voucher_liability', 'fx_clearing'));
ALTER TABLE accounts ADD CHECK ((kind IN ('member_main', 'member_task', 'member_withdrawal_hold')) = (user_id IS NOT NULL));
