-- Owner, 2026-10-30: LivePay (livepay.me) collects activation fees and sends withdrawals through its API
-- (docs/PLAN.md D29). A LivePay payment method is an ordinary payment channel marked with its provider, so the
-- ledger, deposits and withdrawals keep their rules. Each collection or payout sent to the provider is one
-- provider_requests row; money moves only when a status read back from the provider matches the request.

-- Up Migration

ALTER TABLE payment_channels ADD COLUMN provider text CHECK (provider IN ('livepay'));

-- 'api': started by the member through the provider (the claim's transaction ID is our own reference).
ALTER TABLE deposits ADD COLUMN method text NOT NULL DEFAULT 'manual' CHECK (method IN ('manual', 'api'));
ALTER TABLE withdrawals ADD COLUMN payout_method text NOT NULL DEFAULT 'manual' CHECK (payout_method IN ('manual', 'api'));

CREATE TABLE provider_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('livepay', 'simulator')),
  kind text NOT NULL CHECK (kind IN ('collect', 'payout')),
  deposit_id bigint REFERENCES deposits (id),
  withdrawal_id bigint REFERENCES withdrawals (id),
  channel_id bigint NOT NULL REFERENCES payment_channels (id),
  -- Sent to the provider as its unique reference (LivePay: no spaces, at most 30 characters).
  reference text NOT NULL UNIQUE CHECK (reference ~ '^[A-Z0-9-]{4,30}$'),
  phone text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'pending', 'succeeded', 'failed', 'review')),
  provider_ref text CHECK (length(provider_ref) <= 100),
  provider_txn_id text CHECK (length(provider_txn_id) <= 100),
  provider_status text CHECK (length(provider_status) <= 60),
  network text CHECK (length(network) <= 30),
  charge_minor bigint CHECK (charge_minor >= 0),
  message text CHECK (length(message) <= 500),
  checks integer NOT NULL DEFAULT 0,
  last_checked_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'collect') = (deposit_id IS NOT NULL)),
  CHECK ((kind = 'payout') = (withdrawal_id IS NOT NULL)),
  CHECK ((status IN ('succeeded', 'failed')) = (completed_at IS NOT NULL))
);
-- At most one request per deposit, and one open request per withdrawal.
CREATE UNIQUE INDEX provider_requests_deposit_unique ON provider_requests (deposit_id) WHERE deposit_id IS NOT NULL;
CREATE UNIQUE INDEX provider_requests_withdrawal_open ON provider_requests (withdrawal_id) WHERE withdrawal_id IS NOT NULL AND status <> 'failed';
CREATE INDEX provider_requests_open_idx ON provider_requests (status, last_checked_at) WHERE status IN ('queued', 'sent', 'pending', 'review');
CREATE TRIGGER provider_requests_touch BEFORE UPDATE ON provider_requests FOR EACH ROW EXECUTE FUNCTION zx_touch_updated_at();

CREATE FUNCTION zx_provider_request_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider <> OLD.provider OR NEW.kind <> OLD.kind OR NEW.deposit_id IS DISTINCT FROM OLD.deposit_id
     OR NEW.withdrawal_id IS DISTINCT FROM OLD.withdrawal_id OR NEW.channel_id <> OLD.channel_id OR NEW.reference <> OLD.reference
     OR NEW.phone <> OLD.phone OR NEW.amount_minor <> OLD.amount_minor OR NEW.currency_code <> OLD.currency_code OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'zentrix: a provider request cannot be edited' USING ERRCODE = 'ZX002';
  END IF;
  IF OLD.status IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'zentrix: provider request % is closed', OLD.reference USING ERRCODE = 'ZX012';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'queued' AND NEW.status IN ('sent', 'pending', 'succeeded', 'failed', 'review'))
    OR (OLD.status = 'sent' AND NEW.status IN ('pending', 'succeeded', 'failed', 'review'))
    OR (OLD.status = 'pending' AND NEW.status IN ('succeeded', 'failed', 'review'))
    OR (OLD.status = 'review' AND NEW.status IN ('succeeded', 'failed'))
  ) THEN
    RAISE EXCEPTION 'zentrix: provider request cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'ZX012';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER provider_requests_transition BEFORE UPDATE ON provider_requests FOR EACH ROW EXECUTE FUNCTION zx_provider_request_transition();

-- Outgoing provider calls, counted against the provider's rate limits (LivePay: 50 collections and status checks
-- per 15 minutes, 5 payouts a minute). Kept for a day.
CREATE TABLE provider_calls (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('livepay', 'simulator')),
  op text NOT NULL CHECK (op IN ('collect', 'payout', 'status')),
  reference text NOT NULL CHECK (length(reference) <= 30),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_calls_at_idx ON provider_calls (provider, op, at);

-- Webhook deliveries already handled (the provider retries; a replay must change nothing).
CREATE TABLE provider_webhook_events (
  id text PRIMARY KEY CHECK (length(id) <= 100),
  received_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF zx_app_role_exists() THEN
    REVOKE TRUNCATE ON provider_requests, provider_calls, provider_webhook_events FROM zentrix_app;
    REVOKE DELETE ON provider_requests FROM zentrix_app;
  END IF;
END
$$;

-- Down Migration

DROP TABLE provider_webhook_events;
DROP TABLE provider_calls;
DROP TRIGGER provider_requests_transition ON provider_requests;
DROP FUNCTION zx_provider_request_transition();
DROP TABLE provider_requests;
ALTER TABLE withdrawals DROP COLUMN payout_method;
ALTER TABLE deposits DROP COLUMN method;
ALTER TABLE payment_channels DROP COLUMN provider;
