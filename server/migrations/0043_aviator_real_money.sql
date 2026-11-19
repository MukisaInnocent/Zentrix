-- Up Migration

-- Aviator with real money (owner, 2026-11-19; licence NLGRB-BMTOL-26-0290, Uganda). Real money only: demo credits
-- end. Every stake, payout and transfer is a ledger transaction:
--   member_aviator  one per member and currency, the Aviator balance (owed to the member, counted in solvency);
--   aviator_house   one per currency, the company's Aviator money: lost stakes come in, winnings go out. Funded
--                   from platform revenue by an admin. The house limit keeps it at or above the currency's floor.
-- Members move money in from their deposit balance first, then their main balance, and move it out to their main
-- balance, from which it is withdrawn as usual (owner: the Aviator balance can be withdrawn).
-- aviator_bets.amount and payout stay in hundredths of the major unit (as the demo credits were), so the staff
-- dashboard reads the same; the ledger holds minor units. Only currencies with at most 2 decimals can play.

ALTER TABLE accounts DROP CONSTRAINT accounts_kind_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check CHECK (kind IN ('member_main', 'member_deposit', 'member_task', 'member_withdrawal_hold',
  'member_debt', 'member_aviator', 'payment_clearing', 'platform_revenue', 'fees', 'referral_budget', 'promotions_budget', 'owner_capital',
  'suspense', 'voucher_liability', 'fx_clearing', 'campaign_escrow', 'task_credit', 'aviator_house'));
ALTER TABLE accounts DROP CONSTRAINT accounts_member_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_member_check
  CHECK ((kind IN ('member_main', 'member_deposit', 'member_task', 'member_withdrawal_hold', 'member_debt', 'member_aviator')) = (user_id IS NOT NULL));

-- Which currencies play for real money, and each one's house floor (minor units). Off until an admin switches it on.
-- One currency at a time until the staff dashboard splits its figures by currency.
CREATE TABLE aviator_currencies (
  currency_code char(3) PRIMARY KEY REFERENCES currencies (code),
  enabled boolean NOT NULL DEFAULT false,
  floor_minor bigint NOT NULL DEFAULT 0 CHECK (floor_minor >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint REFERENCES users (id)
);
CREATE UNIQUE INDEX aviator_currencies_one_enabled ON aviator_currencies ((true)) WHERE enabled;
INSERT INTO aviator_currencies (currency_code, floor_minor) VALUES ('UGX', 10000);

-- Real-money bets and transfers carry their currency and ledger transactions; demo rows keep currency NULL.
ALTER TABLE aviator_bets
  ADD COLUMN currency_code char(3) REFERENCES currencies (code),
  ADD COLUMN stake_txn bigint REFERENCES ledger_transactions (id),
  ADD COLUMN payout_txn bigint REFERENCES ledger_transactions (id),
  ADD CONSTRAINT aviator_bets_real_check CHECK (currency_code IS NULL OR stake_txn IS NOT NULL);
CREATE INDEX aviator_bets_currency_idx ON aviator_bets (currency_code, created_at) WHERE currency_code IS NOT NULL;
ALTER TABLE aviator_requests
  ADD COLUMN currency_code char(3) REFERENCES currencies (code),
  ADD COLUMN ledger_txn bigint REFERENCES ledger_transactions (id);

DO $$
BEGIN
  IF zx_app_role_exists() THEN
    GRANT SELECT, INSERT, UPDATE ON aviator_currencies TO zentrix_app;
    REVOKE DELETE, TRUNCATE ON aviator_currencies FROM zentrix_app;
  END IF;
END
$$;

-- Down Migration

ALTER TABLE aviator_requests DROP COLUMN ledger_txn, DROP COLUMN currency_code;
DROP INDEX aviator_bets_currency_idx;
ALTER TABLE aviator_bets DROP CONSTRAINT aviator_bets_real_check, DROP COLUMN payout_txn, DROP COLUMN stake_txn, DROP COLUMN currency_code;
DROP TABLE aviator_currencies;
ALTER TABLE accounts DROP CONSTRAINT accounts_member_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_member_check
  CHECK ((kind IN ('member_main', 'member_deposit', 'member_task', 'member_withdrawal_hold', 'member_debt')) = (user_id IS NOT NULL));
ALTER TABLE accounts DROP CONSTRAINT accounts_kind_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check CHECK (kind IN ('member_main', 'member_deposit', 'member_task', 'member_withdrawal_hold',
  'member_debt', 'payment_clearing', 'platform_revenue', 'fees', 'referral_budget', 'promotions_budget', 'owner_capital', 'suspense',
  'voucher_liability', 'fx_clearing', 'campaign_escrow', 'task_credit'));
