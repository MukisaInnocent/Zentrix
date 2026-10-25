-- Owner, 2026-10-25: Zentrix no longer asks for or keeps a date of birth. The column and the values already
-- stored are removed. The users guard no longer mentions it.

-- Up Migration

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

ALTER TABLE users DROP COLUMN date_of_birth;

-- Down Migration

ALTER TABLE users ADD COLUMN date_of_birth date;
