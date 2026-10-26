-- Owner, 2026-10-26: an admin can change the person who invited a member, by username, and the referral
-- rewards follow the new line. Rewards already paid are moved: taken back from the old inviter and paid to the
-- new one. When the old inviter has already used the money, the shortfall becomes a debt (member_debt, a
-- debit-normal account per member), so their balance shows below zero; their next referral earnings repay it.

-- Up Migration

-- The inviter may change only inside an audited admin transaction (zentrix.admin_change = on), and never into a
-- loop (a member cannot end up above themselves).
CREATE OR REPLACE FUNCTION zx_users_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cursor_id bigint;
  steps integer := 0;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.public_id IS DISTINCT FROM OLD.public_id
     OR NEW.referral_code IS DISTINCT FROM OLD.referral_code OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'zentrix: user identity columns are immutable' USING ERRCODE = 'ZX002';
  END IF;
  IF (NEW.country_code IS DISTINCT FROM OLD.country_code OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
      OR NEW.phone_e164 IS DISTINCT FROM OLD.phone_e164 OR NEW.username IS DISTINCT FROM OLD.username
      OR NEW.referred_by_user_id IS DISTINCT FROM OLD.referred_by_user_id)
     AND coalesce(current_setting('zentrix.admin_change', true), '') <> 'on' THEN
    RAISE EXCEPTION 'zentrix: country, currency, phone, username and inviter change only through an audited admin action'
      USING ERRCODE = 'ZX002';
  END IF;
  IF NEW.referred_by_user_id IS DISTINCT FROM OLD.referred_by_user_id THEN
    cursor_id := NEW.referred_by_user_id;
    WHILE cursor_id IS NOT NULL LOOP
      IF cursor_id = NEW.id THEN
        RAISE EXCEPTION 'zentrix: a member cannot be invited by someone below them' USING ERRCODE = 'ZX002';
      END IF;
      steps := steps + 1;
      IF steps > 10000 THEN
        RAISE EXCEPTION 'zentrix: invite chain too long' USING ERRCODE = 'ZX002';
      END IF;
      SELECT referred_by_user_id INTO cursor_id FROM users WHERE id = cursor_id;
    END LOOP;
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON COLUMN users.referred_by_user_id IS 'The member who invited this one. Set at sign-up; changes only through an audited admin action.';

-- A moved reward keeps its row as 'reversed'; the new line gets a new 'credited' row.
ALTER TABLE referral_rewards DROP CONSTRAINT referral_rewards_status_check;
ALTER TABLE referral_rewards ADD CONSTRAINT referral_rewards_status_check CHECK (status IN ('credited', 'pending', 'cancelled', 'reversed'));
ALTER TABLE referral_rewards ADD COLUMN reversed_at timestamptz;

-- What a member owes after a moved reward they had already used. Debit-normal: it grows when debited.
ALTER TABLE accounts DROP CONSTRAINT accounts_kind_check;
ALTER TABLE accounts DROP CONSTRAINT accounts_member_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check CHECK (kind IN ('member_main', 'member_deposit', 'member_task', 'member_withdrawal_hold',
  'member_debt', 'payment_clearing', 'platform_revenue', 'fees', 'referral_budget', 'promotions_budget', 'owner_capital', 'suspense',
  'voucher_liability', 'fx_clearing'));
ALTER TABLE accounts ADD CONSTRAINT accounts_member_check
  CHECK ((kind IN ('member_main', 'member_deposit', 'member_task', 'member_withdrawal_hold', 'member_debt')) = (user_id IS NOT NULL));
ALTER TABLE accounts ALTER COLUMN normal_side SET EXPRESSION AS (CASE WHEN kind IN ('payment_clearing', 'member_debt') THEN 'debit' ELSE 'credit' END);

-- Down Migration

ALTER TABLE accounts ALTER COLUMN normal_side SET EXPRESSION AS (CASE WHEN kind = 'payment_clearing' THEN 'debit' ELSE 'credit' END);
ALTER TABLE accounts DROP CONSTRAINT accounts_member_check;
ALTER TABLE accounts DROP CONSTRAINT accounts_kind_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check CHECK (kind IN ('member_main', 'member_deposit', 'member_task', 'member_withdrawal_hold',
  'payment_clearing', 'platform_revenue', 'fees', 'referral_budget', 'promotions_budget', 'owner_capital', 'suspense', 'voucher_liability', 'fx_clearing'));
ALTER TABLE accounts ADD CONSTRAINT accounts_member_check CHECK ((kind IN ('member_main', 'member_deposit', 'member_task', 'member_withdrawal_hold')) = (user_id IS NOT NULL));
ALTER TABLE referral_rewards DROP COLUMN reversed_at;
ALTER TABLE referral_rewards DROP CONSTRAINT referral_rewards_status_check;
ALTER TABLE referral_rewards ADD CONSTRAINT referral_rewards_status_check CHECK (status IN ('credited', 'pending', 'cancelled'));
CREATE OR REPLACE FUNCTION zx_users_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.public_id IS DISTINCT FROM OLD.public_id
     OR NEW.referral_code IS DISTINCT FROM OLD.referral_code OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'zentrix: user identity columns are immutable' USING ERRCODE = 'ZX002';
  END IF;
  IF NEW.referred_by_user_id IS DISTINCT FROM OLD.referred_by_user_id THEN
    RAISE EXCEPTION 'zentrix: the referrer cannot change after sign-up' USING ERRCODE = 'ZX002';
  END IF;
  IF (NEW.country_code IS DISTINCT FROM OLD.country_code OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
      OR NEW.phone_e164 IS DISTINCT FROM OLD.phone_e164 OR NEW.username IS DISTINCT FROM OLD.username)
     AND coalesce(current_setting('zentrix.admin_change', true), '') <> 'on' THEN
    RAISE EXCEPTION 'zentrix: country, currency, phone and username change only through an audited admin action'
      USING ERRCODE = 'ZX002';
  END IF;
  RETURN NEW;
END
$$;
