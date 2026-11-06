-- Owner, 2026-11-06 (rule 4 removed): Betting tips and Aviator.
-- Betting tips: admins post football tips (match, league, kick-off, tip, odds) and later the result. Members read them.
-- Aviator: the owner's own Aviator project, brought over (see below).

-- Up Migration

CREATE TABLE betting_tips (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  league text NOT NULL DEFAULT '' CHECK (length(league) <= 80),
  home_team text NOT NULL CHECK (length(home_team) BETWEEN 1 AND 80),
  away_team text NOT NULL CHECK (length(away_team) BETWEEN 1 AND 80),
  kickoff_at timestamptz NOT NULL,
  tip text NOT NULL CHECK (length(tip) BETWEEN 1 AND 80),
  odds numeric(8, 2) CHECK (odds IS NULL OR odds >= 1),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  result text NOT NULL DEFAULT 'pending' CHECK (result IN ('pending', 'won', 'lost', 'void')),
  score text NOT NULL DEFAULT '' CHECK (length(score) <= 20),
  published boolean NOT NULL DEFAULT true,
  created_by bigint NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz
);
CREATE INDEX betting_tips_list_idx ON betting_tips (kickoff_at DESC) WHERE removed_at IS NULL;
CREATE TRIGGER betting_tips_touch BEFORE UPDATE ON betting_tips FOR EACH ROW EXECUTE FUNCTION zx_touch_updated_at();

-- Aviator, brought from the owner's Aviator project (Flask) as it is: one shared round for everyone, an 8-second betting
-- window, then the multiplier grows as 1.1^t until the crash point the server drew before the round. Players bet demo
-- credits (no cash value); a member asks for credits or asks to remove them, and staff approve or reject.
-- Amounts are hundredths of a credit (bigint), like the project's Numeric(10, 2).
CREATE TABLE aviator_rounds (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  crash_point numeric(10, 2) NOT NULL CHECK (crash_point >= 1),
  start_time timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'active', 'crashed'))
);

CREATE TABLE aviator_wallets (
  user_id bigint PRIMARY KEY REFERENCES users (id),
  balance bigint NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE aviator_bets (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  round_id bigint NOT NULL REFERENCES aviator_rounds (id),
  user_id bigint NOT NULL REFERENCES users (id),
  amount bigint NOT NULL CHECK (amount > 0),
  multiplier double precision NOT NULL DEFAULT 0,
  result text NOT NULL DEFAULT 'pending' CHECK (result IN ('pending', 'win', 'loss')),
  payout bigint NOT NULL DEFAULT 0 CHECK (payout >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (round_id, user_id)
);
CREATE INDEX aviator_bets_round_idx ON aviator_bets (round_id) WHERE result = 'pending';
CREATE INDEX aviator_bets_user_idx ON aviator_bets (user_id, id DESC);

-- Requests for demo credits (deposit) and to remove them (withdrawal), approved by staff.
CREATE TABLE aviator_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  user_id bigint NOT NULL REFERENCES users (id),
  kind text NOT NULL CHECK (kind IN ('deposit', 'withdrawal')),
  amount bigint NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by bigint REFERENCES users (id),
  decided_at timestamptz
);
CREATE INDEX aviator_requests_status_idx ON aviator_requests (status, id DESC);

DO $$
BEGIN
  IF zx_app_role_exists() THEN
    GRANT SELECT, INSERT, UPDATE ON betting_tips, aviator_rounds, aviator_wallets, aviator_bets, aviator_requests TO zentrix_app;
    REVOKE DELETE, TRUNCATE ON betting_tips, aviator_rounds, aviator_wallets, aviator_bets, aviator_requests FROM zentrix_app;
  END IF;
END
$$;

-- Down Migration

DROP TABLE aviator_requests;
DROP TABLE aviator_bets;
DROP TABLE aviator_wallets;
DROP TABLE aviator_rounds;
DROP TABLE betting_tips;
