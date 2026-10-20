CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(30) NOT NULL UNIQUE,
  email VARCHAR(254) NOT NULL UNIQUE,
  phone VARCHAR(30),
  password_hash TEXT NOT NULL,
  referral_code VARCHAR(12) NOT NULL UNIQUE,
  account_status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (account_status IN ('active', 'pending_payment')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status VARCHAR(20) NOT NULL DEFAULT 'active'
  CHECK (account_status IN ('active', 'pending_payment'));

CREATE TABLE IF NOT EXISTS wallets (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance_ugx BIGINT NOT NULL DEFAULT 0 CHECK (balance_ugx >= 0),
  reserved_ugx BIGINT NOT NULL DEFAULT 0 CHECK (reserved_ugx >= 0 AND reserved_ugx <= balance_ugx),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS money_requests (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind VARCHAR(12) NOT NULL CHECK (kind IN ('deposit', 'withdrawal')),
  amount_ugx BIGINT NOT NULL CHECK (amount_ugx > 0),
  method VARCHAR(20) NOT NULL CHECK (method IN ('mobile_money', 'bank_transfer')),
  destination VARCHAR(100) NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'rejected')),
  provider VARCHAR(20) NOT NULL DEFAULT 'mock',
  request_type VARCHAR(20) NOT NULL DEFAULT 'standard'
    CHECK (request_type IN ('standard', 'initial_deposit')),
  provider_reference VARCHAR(100),
  reference VARCHAR(24) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE money_requests ADD COLUMN IF NOT EXISTS request_type VARCHAR(20) NOT NULL DEFAULT 'standard'
  CHECK (request_type IN ('standard', 'initial_deposit'));
ALTER TABLE money_requests ADD COLUMN IF NOT EXISTS provider_reference VARCHAR(100);

CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);
CREATE INDEX IF NOT EXISTS money_requests_user_created_idx ON money_requests (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS money_requests_provider_reference_idx
  ON money_requests (provider, provider_reference) WHERE provider_reference IS NOT NULL;
