-- Identity, sessions, verification, two-factor auth, consent, fraud flags, rate limits and the audit log.

-- Up Migration

CREATE TABLE users (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9_]{3,30}$'),
  email text UNIQUE CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254 AND position('@' IN email) > 1),
  email_verified_at timestamptz,
  phone_e164 text UNIQUE CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  phone_verified_at timestamptz,
  password_hash text NOT NULL,
  country_code char(2) NOT NULL REFERENCES countries (code),
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  locale text NOT NULL CHECK (length(locale) BETWEEN 2 AND 35),
  timezone text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 64),
  date_of_birth date NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'closed')),
  status_reason text,
  referral_code text NOT NULL UNIQUE CHECK (referral_code ~ '^[A-Z2-9]{8}$'),
  referred_by_user_id bigint REFERENCES users (id),
  failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until timestamptz,
  withdrawals_locked_until timestamptz,
  last_login_at timestamptz,
  anonymized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (referred_by_user_id IS NULL OR referred_by_user_id <> id),
  CHECK (anonymized_at IS NOT NULL OR (email IS NOT NULL AND phone_e164 IS NOT NULL))
);
CREATE INDEX users_referred_by_idx ON users (referred_by_user_id) WHERE referred_by_user_id IS NOT NULL;
COMMENT ON COLUMN users.referred_by_user_id IS 'Direct referrer only (single level, rule 3.2). Set at sign-up and never changed.';

-- Guards the columns that must not change once an account exists. Country, currency and phone may only
-- change inside an audited admin transaction, which sets zentrix.admin_change = on (section 1 and 10).
CREATE FUNCTION zx_users_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.public_id IS DISTINCT FROM OLD.public_id
     OR NEW.referral_code IS DISTINCT FROM OLD.referral_code OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.date_of_birth IS DISTINCT FROM OLD.date_of_birth THEN
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
CREATE TRIGGER users_guard BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION zx_users_guard();
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION zx_touch_updated_at();
CREATE TRIGGER users_no_delete BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION zx_forbid_mutation();

CREATE TABLE roles (
  name text PRIMARY KEY CHECK (name ~ '^[a-z]{3,20}$'),
  description text NOT NULL,
  is_staff boolean NOT NULL
);
INSERT INTO roles (name, description, is_staff) VALUES
  ('member', 'Member: tasks, learning and wallet', false),
  ('advertiser', 'Advertiser: funds campaigns', false),
  ('support', 'Support: reads member records, answers tickets', true),
  ('reviewer', 'Reviewer: task proofs and campaign approvals', true),
  ('finance', 'Finance: payments, withdrawals, reconciliation', true),
  ('compliance', 'Compliance: KYC, fraud flags, freezes', true),
  ('admin', 'Administrator: settings, roles and everything else', true);

CREATE TABLE user_roles (
  user_id bigint NOT NULL REFERENCES users (id),
  role text NOT NULL REFERENCES roles (name),
  granted_by bigint REFERENCES users (id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE sessions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users (id),
  token_hash bytea NOT NULL UNIQUE,
  previous_token_hash bytea,
  previous_valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  mfa_verified_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  ip inet,
  user_agent text CHECK (length(user_agent) <= 300)
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_previous_token_idx ON sessions (previous_token_hash) WHERE previous_token_hash IS NOT NULL;
COMMENT ON COLUMN sessions.token_hash IS 'SHA-256 of the cookie token. The token itself is never stored.';

CREATE TABLE mfa_challenges (
  token_hash bytea PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users (id),
  expires_at timestamptz NOT NULL,
  attempts smallint NOT NULL DEFAULT 0,
  used_at timestamptz,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE totp_credentials (
  user_id bigint PRIMARY KEY REFERENCES users (id),
  secret_ciphertext bytea NOT NULL,
  enabled_at timestamptz,
  last_used_step bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN totp_credentials.secret_ciphertext IS 'AES-256-GCM (iv | tag | ciphertext) under DATA_ENCRYPTION_KEY. Never plaintext (rule 3.8).';
CREATE TRIGGER totp_touch BEFORE UPDATE ON totp_credentials FOR EACH ROW EXECUTE FUNCTION zx_touch_updated_at();

CREATE TABLE recovery_codes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users (id),
  code_hash bytea NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash)
);

CREATE TABLE consents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users (id),
  kind text NOT NULL CHECK (kind IN ('terms', 'privacy', 'age_18_or_over', 'marketing')),
  version text NOT NULL,
  accepted boolean NOT NULL,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consents_user_idx ON consents (user_id, kind, created_at DESC);
CREATE TRIGGER consents_append_only BEFORE UPDATE OR DELETE ON consents FOR EACH ROW EXECUTE FUNCTION zx_forbid_mutation();

CREATE TABLE email_verifications (
  token_hash bytea PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users (id),
  email text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE phone_verifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users (id),
  phone_e164 text NOT NULL,
  code_hash bytea NOT NULL,
  attempts smallint NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX phone_verifications_user_idx ON phone_verifications (user_id, created_at DESC);

CREATE TABLE password_resets (
  token_hash bytea PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users (id),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint REFERENCES users (id),
  kind text NOT NULL CHECK (kind ~ '^[a-z_]{3,40}$'),
  ip inet,
  user_agent text CHECK (length(user_agent) <= 300),
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_events_user_idx ON auth_events (user_id, created_at DESC);
CREATE INDEX auth_events_ip_idx ON auth_events (ip, kind, created_at DESC);

CREATE TABLE fraud_flags (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users (id),
  kind text NOT NULL CHECK (kind ~ '^[a-z_]{3,50}$'),
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high')),
  details jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'confirmed')),
  reviewed_by bigint REFERENCES users (id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'open') = (reviewed_at IS NULL))
);
CREATE INDEX fraud_flags_open_idx ON fraud_flags (created_at DESC) WHERE status = 'open';
CREATE INDEX fraud_flags_user_idx ON fraud_flags (user_id);

CREATE TABLE rate_limits (
  key text PRIMARY KEY,
  hits integer NOT NULL,
  reset_at timestamptz NOT NULL
);

-- Test mode only: outgoing email and SMS land here when no SMTP/SMS provider is configured (decision D18).
CREATE TABLE dev_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  recipient text NOT NULL,
  subject text,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Every staff action: who, what, before/after, IP and time (section 11). Append-only.
CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id bigint REFERENCES users (id),
  actor_roles text[] NOT NULL DEFAULT '{}',
  action text NOT NULL CHECK (action ~ '^[a-z0-9_.]{3,80}$'),
  target_type text,
  target_id text,
  before jsonb,
  after jsonb,
  reason text,
  ip inet,
  user_agent text CHECK (length(user_agent) <= 300),
  request_id text
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
CREATE INDEX audit_log_target_idx ON audit_log (target_type, target_id, created_at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_user_id, created_at DESC);
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION zx_forbid_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION zx_forbid_mutation();

DO $$
BEGIN
  IF zx_app_role_exists() THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_log, consents, roles FROM zentrix_app;
    REVOKE DELETE, TRUNCATE ON users FROM zentrix_app;
  END IF;
END
$$;

-- Down Migration

DROP TABLE audit_log;
DROP TABLE dev_outbox;
DROP TABLE rate_limits;
DROP TABLE fraud_flags;
DROP TABLE auth_events;
DROP TABLE password_resets;
DROP TABLE phone_verifications;
DROP TABLE email_verifications;
DROP TABLE consents;
DROP TABLE recovery_codes;
DROP TABLE totp_credentials;
DROP TABLE mfa_challenges;
DROP TABLE sessions;
DROP TABLE user_roles;
DROP TABLE roles;
DROP TABLE users;
DROP FUNCTION zx_users_guard();
