-- Owner requests of 2026-10-25: the activation fee is paid by manual deposit before a member can use the site;
-- no date of birth at sign-up; USSD and merchant codes on payment channels; members change their password, email
-- or phone only after an admin unlocks it; every country can activate; payouts go from whichever channel staff use.

-- Up Migration

ALTER TABLE users ALTER COLUMN date_of_birth DROP NOT NULL;

ALTER TABLE payment_channels
  ADD COLUMN ussd_code text CHECK (ussd_code IS NULL OR length(ussd_code) BETWEEN 2 AND 40),
  ADD COLUMN merchant_code text CHECK (merchant_code IS NULL OR length(merchant_code) BETWEEN 2 AND 40);

-- A withdrawal's channel is set to a default when requested and confirmed by staff when they send the money, so
-- it may change until the withdrawal is closed. Everything else about the request still cannot change.
CREATE OR REPLACE FUNCTION zx_withdrawal_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reference <> OLD.reference OR NEW.user_id <> OLD.user_id OR NEW.source_account_id <> OLD.source_account_id
     OR NEW.payout_phone <> OLD.payout_phone OR NEW.amount_minor <> OLD.amount_minor
     OR NEW.fee_minor <> OLD.fee_minor OR NEW.currency_code <> OLD.currency_code OR NEW.needs_two_people <> OLD.needs_two_people
     OR NEW.hold_transaction_id <> OLD.hold_transaction_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'zentrix: a withdrawal request cannot be edited' USING ERRCODE = 'ZX002';
  END IF;
  IF OLD.status IN ('paid', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'zentrix: withdrawal % is closed', OLD.reference USING ERRCODE = 'ZX012';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'requested' AND NEW.status IN ('approved', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status IN ('processing', 'cancelled'))
    OR (OLD.status = 'processing' AND NEW.status IN ('paid', 'failed'))
  ) THEN
    RAISE EXCEPTION 'zentrix: withdrawal cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'ZX012';
  END IF;
  RETURN NEW;
END
$$;

-- An admin unlocks one change (password, email or phone) for a member who contacted them. The grant lasts 24
-- hours, works once, and records how the admin verified the member.
CREATE TABLE profile_change_grants (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users (id),
  kind text NOT NULL CHECK (kind IN ('password', 'email', 'phone')),
  granted_by bigint NOT NULL REFERENCES users (id),
  verification text NOT NULL CHECK (length(verification) BETWEEN 10 AND 500),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (granted_by <> user_id)
);
CREATE INDEX profile_change_grants_open_idx ON profile_change_grants (user_id, kind) WHERE used_at IS NULL;

-- Which country a browser time zone belongs to, for picking the country at sign-up. Filled by 0010.
CREATE TABLE country_timezones (
  timezone text PRIMARY KEY CHECK (length(timezone) BETWEEN 3 AND 64),
  country_code char(2) NOT NULL REFERENCES countries (code)
);

-- Down Migration

DROP TABLE country_timezones;
DROP TABLE profile_change_grants;
ALTER TABLE payment_channels DROP COLUMN merchant_code, DROP COLUMN ussd_code;
