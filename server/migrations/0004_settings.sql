-- Versioned global settings, versioned per-country configuration, and the go-live checklist.

-- Up Migration

-- Global settings: every change is a new version row (append-only). The application validates each
-- key's value with a Zod schema before inserting.
CREATE TABLE settings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key text NOT NULL CHECK (key ~ '^[a-z0-9_.]{3,80}$'),
  value jsonb NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  note text,
  created_by bigint REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key, version)
);
CREATE TRIGGER settings_append_only BEFORE UPDATE OR DELETE ON settings FOR EACH ROW EXECUTE FUNCTION zx_forbid_mutation();
CREATE VIEW current_settings AS
  SELECT DISTINCT ON (key) key, value, version, created_by, created_at FROM settings ORDER BY key, version DESC;

-- Per-country configuration (section 5b). Every edit inserts a new version; the latest version applies.
-- Money values are BIGINT minor units in the country's currency.
CREATE TABLE country_configs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  country_code char(2) NOT NULL REFERENCES countries (code),
  version integer NOT NULL CHECK (version > 0),
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  membership_fee_minor bigint NOT NULL CHECK (membership_fee_minor > 0),
  withdrawal_min_minor bigint NOT NULL CHECK (withdrawal_min_minor > 0),
  withdrawal_max_minor bigint NOT NULL,
  withdrawal_daily_max_minor bigint NOT NULL,
  withdrawal_monthly_max_minor bigint NOT NULL,
  withdrawal_fee_bp integer NOT NULL CHECK (withdrawal_fee_bp BETWEEN 0 AND 2000),
  withdrawal_fee_min_minor bigint NOT NULL DEFAULT 0 CHECK (withdrawal_fee_min_minor >= 0),
  withdrawal_approval_threshold_minor bigint NOT NULL CHECK (withdrawal_approval_threshold_minor > 0),
  new_account_review_days integer NOT NULL DEFAULT 14 CHECK (new_account_review_days BETWEEN 0 AND 365),
  vat_bp integer NOT NULL DEFAULT 0 CHECK (vat_bp BETWEEN 0 AND 5000),
  kyc_level_for_withdrawal smallint NOT NULL DEFAULT 0 CHECK (kyc_level_for_withdrawal BETWEEN 0 AND 3),
  engagement_tasks_enabled boolean NOT NULL DEFAULT true,
  terms_version text NOT NULL CHECK (length(terms_version) BETWEEN 1 AND 40),
  privacy_version text NOT NULL CHECK (length(privacy_version) BETWEEN 1 AND 40),
  is_placeholder boolean NOT NULL DEFAULT true,
  note text,
  created_by bigint REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (country_code, version),
  CHECK (withdrawal_min_minor <= withdrawal_max_minor),
  CHECK (withdrawal_max_minor <= withdrawal_daily_max_minor),
  CHECK (withdrawal_daily_max_minor <= withdrawal_monthly_max_minor)
);
COMMENT ON COLUMN country_configs.withdrawal_fee_bp IS 'Basis points of the amount withdrawn (50 = 0.5%, owner decision of 2026-10-21).';
COMMENT ON COLUMN country_configs.is_placeholder IS 'True while values are defaults the owner has not confirmed (TODO(owner)).';
CREATE TRIGGER country_configs_append_only BEFORE UPDATE OR DELETE ON country_configs
  FOR EACH ROW EXECUTE FUNCTION zx_forbid_mutation();

-- A config's currency must be the country's wallet currency.
CREATE FUNCTION zx_country_config_currency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM countries WHERE code = NEW.country_code AND currency_code = NEW.currency_code) THEN
    RAISE EXCEPTION 'zentrix: config currency % does not match the currency of country %', NEW.currency_code, NEW.country_code
      USING ERRCODE = 'ZX003';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER country_configs_currency BEFORE INSERT ON country_configs
  FOR EACH ROW EXECUTE FUNCTION zx_country_config_currency();

CREATE VIEW current_country_configs AS
  SELECT DISTINCT ON (country_code) * FROM country_configs ORDER BY country_code, version DESC;

-- Go-live gate (section 0, decision D20). The owner removed legal sign-off, so the items are operational.
CREATE TABLE go_live_items (
  key text PRIMARY KEY CHECK (key ~ '^[a-z_]{3,40}$'),
  label text NOT NULL,
  sort smallint NOT NULL
);
INSERT INTO go_live_items (key, label, sort) VALUES
  ('provider_keys', 'Real payment-provider keys are configured and a live test payment succeeded', 1),
  ('backups_verified', 'Encrypted backups run and a restore drill was completed', 2),
  ('security_review', 'Security review against THREAT_MODEL.md is complete and findings are closed', 3),
  ('public_pages', 'Terms, Privacy, Risk and Refund pages are published', 4),
  ('sanctions_list', 'The sanctions and restricted-country list is loaded and reviewed', 5),
  ('kyc_rules', 'KYC tiers and withdrawal limits are configured for every enabled country', 6),
  ('owner_approval', 'The owner approves taking real money', 7);

CREATE TABLE go_live_signoffs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_key text NOT NULL REFERENCES go_live_items (key),
  action text NOT NULL CHECK (action IN ('sign', 'revoke')),
  actor_user_id bigint NOT NULL REFERENCES users (id),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER go_live_signoffs_append_only BEFORE UPDATE OR DELETE ON go_live_signoffs
  FOR EACH ROW EXECUTE FUNCTION zx_forbid_mutation();
CREATE VIEW go_live_status AS
  SELECT i.key, i.label, i.sort, s.action = 'sign' AS signed, s.actor_user_id, s.created_at AS changed_at
  FROM go_live_items i
  LEFT JOIN LATERAL (
    SELECT action, actor_user_id, created_at FROM go_live_signoffs g WHERE g.item_key = i.key ORDER BY g.id DESC LIMIT 1
  ) s ON true;

DO $$
BEGIN
  IF zx_app_role_exists() THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON settings, country_configs, go_live_signoffs, go_live_items FROM zentrix_app;
    REVOKE DELETE, TRUNCATE ON countries, currencies FROM zentrix_app;
    GRANT SELECT ON current_settings, current_country_configs, go_live_status TO zentrix_app;
  END IF;
END
$$;

-- Down Migration

DROP VIEW go_live_status;
DROP TABLE go_live_signoffs;
DROP TABLE go_live_items;
DROP VIEW current_country_configs;
DROP TABLE country_configs;
DROP FUNCTION zx_country_config_currency();
DROP VIEW current_settings;
DROP TABLE settings;
