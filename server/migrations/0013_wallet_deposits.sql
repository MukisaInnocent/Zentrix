-- Owner, 2026-10-25: deposits come back. A deposit is either the activation fee (which opens the account and goes
-- to platform revenue) or a wallet deposit (which, once staff confirm it, is credited to the member's balance).

-- Up Migration

ALTER TABLE deposits ADD COLUMN purpose text NOT NULL DEFAULT 'activation' CHECK (purpose IN ('activation', 'wallet'));

CREATE OR REPLACE FUNCTION zx_deposit_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reference <> OLD.reference OR NEW.user_id <> OLD.user_id OR NEW.channel_id <> OLD.channel_id
     OR NEW.claimed_amount_minor <> OLD.claimed_amount_minor OR NEW.currency_code <> OLD.currency_code
     OR NEW.sender_phone <> OLD.sender_phone OR NEW.provider_txn_id <> OLD.provider_txn_id OR NEW.created_at <> OLD.created_at
     OR NEW.purpose <> OLD.purpose THEN
    RAISE EXCEPTION 'zentrix: a deposit claim cannot be edited' USING ERRCODE = 'ZX002';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'pending' AND NEW.status IN ('confirmed', 'rejected', 'cancelled')) THEN
    RAISE EXCEPTION 'zentrix: deposit cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'ZX012';
  END IF;
  IF OLD.status <> 'pending' AND (NEW.credited_amount_minor IS DISTINCT FROM OLD.credited_amount_minor
     OR NEW.ledger_transaction_id IS DISTINCT FROM OLD.ledger_transaction_id OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by) THEN
    RAISE EXCEPTION 'zentrix: a closed deposit cannot be changed' USING ERRCODE = 'ZX012';
  END IF;
  RETURN NEW;
END
$$;

-- Down Migration

ALTER TABLE deposits DROP COLUMN purpose;
