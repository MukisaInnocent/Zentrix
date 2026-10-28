-- Owner, 2026-10-28: a member who invites someone from another country receives the referral reward in their own
-- currency, converted at the latest exchange rate. Rates come from an exchange-rate API (one row per currency, in
-- units per US dollar) and are append-only. A converted reward records what it was worth in the invited member's
-- currency and the rate used. When no recent rate exists the reward waits as 'pending' (no amount yet) and is paid
-- after the next rate refresh.

-- Up Migration

CREATE TABLE fx_rates (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  units_per_usd numeric(30, 12) NOT NULL CHECK (units_per_usd > 0),
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 60),
  rate_at timestamptz NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (currency_code, source, rate_at)
);
COMMENT ON TABLE fx_rates IS 'Exchange rates as units of a currency per US dollar. rate_at is the provider''s time. Append-only.';
CREATE INDEX fx_rates_latest_idx ON fx_rates (currency_code, rate_at DESC, id DESC);
CREATE TRIGGER fx_rates_append_only BEFORE UPDATE OR DELETE ON fx_rates FOR EACH ROW EXECUTE FUNCTION zx_forbid_mutation();

ALTER TABLE referral_rewards
  ADD COLUMN source_amount_minor bigint CHECK (source_amount_minor > 0),
  ADD COLUMN source_currency_code char(3) REFERENCES currencies (code),
  ADD COLUMN fx_rate numeric(30, 12) CHECK (fx_rate > 0),
  ADD COLUMN fx_rate_at timestamptz;
COMMENT ON COLUMN referral_rewards.amount_minor IS 'What the referrer received, in currency_code (the referrer''s currency). Empty while pending.';
COMMENT ON COLUMN referral_rewards.source_amount_minor IS 'The reward in the invited member''s currency, when it was converted.';
COMMENT ON COLUMN referral_rewards.fx_rate IS 'Units of currency_code per unit of source_currency_code used for the conversion.';
ALTER TABLE referral_rewards ALTER COLUMN amount_minor DROP NOT NULL;
ALTER TABLE referral_rewards ADD CONSTRAINT referral_rewards_amount_set CHECK (amount_minor IS NOT NULL OR status IN ('pending', 'cancelled'));
ALTER TABLE referral_rewards ADD CONSTRAINT referral_rewards_source_pair
  CHECK ((source_amount_minor IS NULL) = (source_currency_code IS NULL) AND (fx_rate IS NULL OR source_amount_minor IS NOT NULL));
CREATE INDEX referral_rewards_pending_idx ON referral_rewards (id) WHERE status = 'pending';

DO $$
BEGIN
  IF zx_app_role_exists() THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON fx_rates FROM zentrix_app;
  END IF;
END
$$;

-- Down Migration

DROP INDEX referral_rewards_pending_idx;
DELETE FROM referral_rewards WHERE amount_minor IS NULL;
ALTER TABLE referral_rewards DROP CONSTRAINT referral_rewards_source_pair;
ALTER TABLE referral_rewards DROP CONSTRAINT referral_rewards_amount_set;
ALTER TABLE referral_rewards ALTER COLUMN amount_minor SET NOT NULL;
ALTER TABLE referral_rewards DROP COLUMN fx_rate_at, DROP COLUMN fx_rate, DROP COLUMN source_currency_code, DROP COLUMN source_amount_minor;
DROP TABLE fx_rates;
