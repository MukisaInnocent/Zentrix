-- Wallets, multi-level referrals, transactions, money requests, tasks, vouchers and client payments.

-- Up Migration

CREATE TABLE wallets (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL UNIQUE REFERENCES users (id),
  currency_code char(3) NOT NULL REFERENCES currencies (code) DEFAULT 'UGX',
  balance_minor bigint NOT NULL DEFAULT 0 CHECK (balance_minor >= 0),
  task_balance_youtube_minor bigint NOT NULL DEFAULT 0 CHECK (task_balance_youtube_minor >= 0),
  task_balance_tiktok_minor bigint NOT NULL DEFAULT 0 CHECK (task_balance_tiktok_minor >= 0),
  task_balance_ads_minor bigint NOT NULL DEFAULT 0 CHECK (task_balance_ads_minor >= 0),
  task_balance_trivia_minor bigint NOT NULL DEFAULT 0 CHECK (task_balance_trivia_minor >= 0),
  task_balance_fixtap_minor bigint NOT NULL DEFAULT 0 CHECK (task_balance_fixtap_minor >= 0),
  task_balance_music_minor bigint NOT NULL DEFAULT 0 CHECK (task_balance_music_minor >= 0),
  total_deposited_minor bigint NOT NULL DEFAULT 0 CHECK (total_deposited_minor >= 0),
  total_withdrawn_minor bigint NOT NULL DEFAULT 0 CHECK (total_withdrawn_minor >= 0),
  reserved_balance_minor bigint NOT NULL DEFAULT 0 CHECK (reserved_balance_minor >= 0),
  total_referral_earned_minor bigint NOT NULL DEFAULT 0 CHECK (total_referral_earned_minor >= 0),
  membership_active boolean NOT NULL DEFAULT false,
  membership_activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallets_user_idx ON wallets (user_id);
CREATE TRIGGER wallets_touch BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION zx_touch_updated_at();

-- Multi-level referral commission records
CREATE TABLE referral_rewards (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  referrer_user_id bigint NOT NULL REFERENCES users (id),
  referred_user_id bigint NOT NULL REFERENCES users (id),
  level integer NOT NULL CHECK (level >= 1),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  status text NOT NULL DEFAULT 'credited' CHECK (status IN ('credited', 'pending', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX referral_rewards_referrer_idx ON referral_rewards (referrer_user_id, created_at DESC);
CREATE INDEX referral_rewards_referred_idx ON referral_rewards (referred_user_id);

-- Wallet transaction history
CREATE TABLE wallet_transactions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users (id),
  kind text NOT NULL CHECK (kind IN ('deposit', 'withdrawal', 'referral_bonus', 'membership_fee', 'task_reward', 'voucher_purchase', 'voucher_redeem', 'client_payment', 'transfer')),
  amount_minor bigint NOT NULL,
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  balance_after_minor bigint NOT NULL,
  description text NOT NULL,
  reference text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallet_transactions_user_idx ON wallet_transactions (user_id, created_at DESC);

-- Money requests: deposits and withdrawals
CREATE TABLE money_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  user_id bigint NOT NULL REFERENCES users (id),
  kind text NOT NULL CHECK (kind IN ('deposit', 'withdrawal')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  fee_minor bigint NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  method text NOT NULL DEFAULT 'mobile_money',
  destination text,
  reference text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX money_requests_user_idx ON money_requests (user_id, created_at DESC);
CREATE INDEX money_requests_ref_idx ON money_requests (reference);

-- Tasks catalogue
CREATE TABLE tasks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  module text NOT NULL CHECK (module IN ('youtube', 'tiktok', 'ads', 'trivia', 'fixtap', 'music')),
  title text NOT NULL,
  description text NOT NULL,
  reward_minor bigint NOT NULL CHECK (reward_minor > 0),
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  url text,
  duration_sec integer,
  details jsonb NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_module_idx ON tasks (module) WHERE is_active = true;

-- Task submissions and completion proof
CREATE TABLE task_submissions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users (id),
  task_id bigint NOT NULL REFERENCES tasks (id),
  proof_text text,
  status text NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved', 'rejected')),
  reward_minor bigint NOT NULL,
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_submissions_user_idx ON task_submissions (user_id, created_at DESC);
CREATE INDEX task_submissions_task_idx ON task_submissions (task_id);

-- Vouchers for activation or wallet transfer
CREATE TABLE vouchers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9-]{10,25}$'),
  creator_user_id bigint NOT NULL REFERENCES users (id),
  redeemed_by_user_id bigint REFERENCES users (id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'redeemed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  redeemed_at timestamptz
);
CREATE INDEX vouchers_code_idx ON vouchers (code);
CREATE INDEX vouchers_creator_idx ON vouchers (creator_user_id, created_at DESC);

-- Client payments (Pay For Client)
CREATE TABLE client_payments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payer_user_id bigint NOT NULL REFERENCES users (id),
  client_name text NOT NULL,
  client_phone text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  note text,
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'pending', 'failed')),
  reference text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX client_payments_payer_idx ON client_payments (payer_user_id, created_at DESC);

-- Automatically create a wallet row on user creation
CREATE OR REPLACE FUNCTION zx_create_user_wallet() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO wallets (user_id, currency_code)
  VALUES (NEW.id, NEW.currency_code)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_create_wallet AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION zx_create_user_wallet();

-- Backfill any existing users without a wallet
INSERT INTO wallets (user_id, currency_code)
SELECT id, currency_code FROM users
ON CONFLICT (user_id) DO NOTHING;

-- Grant access to app role if present
DO $$
BEGIN
  IF zx_app_role_exists() THEN
    GRANT SELECT, INSERT, UPDATE ON wallets, referral_rewards, wallet_transactions, money_requests, tasks, task_submissions, vouchers, client_payments TO zentrix_app;
  END IF;
END
$$;

-- Down Migration

DROP TABLE IF EXISTS client_payments;
DROP TABLE IF EXISTS vouchers;
DROP TABLE IF EXISTS task_submissions;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS money_requests;
DROP TABLE IF EXISTS wallet_transactions;
DROP TABLE IF EXISTS referral_rewards;
DROP TRIGGER IF EXISTS users_create_wallet ON users;
DROP FUNCTION IF EXISTS zx_create_user_wallet();
DROP TABLE IF EXISTS wallets;
