-- Owner, 2026-11-06 (rule 4 removed): Betting tips and Aviator.
-- Betting tips: admins post football tips (match, league, kick-off, tip, odds) and later the result. Members read them.
-- Aviator: a crash game played with free game points, not money, until the owner gives the money rules. The server
-- picks each round's crash point before the round starts and works out the cash-out multiplier from its own clock.

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

-- Game points per member (not money). Topped back up to the daily amount once a day when below it.
CREATE TABLE aviator_wallets (
  user_id bigint PRIMARY KEY REFERENCES users (id),
  points bigint NOT NULL CHECK (points >= 0),
  refilled_on date NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE aviator_rounds (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  user_id bigint NOT NULL REFERENCES users (id),
  stake bigint NOT NULL CHECK (stake > 0),
  -- Hundredths: 100 = 1.00x. Chosen before the round starts; never sent to the browser while the round runs.
  crash_x100 integer NOT NULL CHECK (crash_x100 >= 100),
  started_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'flying' CHECK (status IN ('flying', 'cashed', 'crashed')),
  cashout_x100 integer CHECK (cashout_x100 >= 100),
  payout bigint NOT NULL DEFAULT 0 CHECK (payout >= 0),
  ended_at timestamptz
);
CREATE INDEX aviator_rounds_user_idx ON aviator_rounds (user_id, id DESC);
CREATE UNIQUE INDEX aviator_rounds_one_flying ON aviator_rounds (user_id) WHERE status = 'flying';

DO $$
BEGIN
  IF zx_app_role_exists() THEN
    GRANT SELECT, INSERT, UPDATE ON betting_tips, aviator_wallets, aviator_rounds TO zentrix_app;
    REVOKE DELETE, TRUNCATE ON betting_tips, aviator_wallets, aviator_rounds FROM zentrix_app;
  END IF;
END
$$;

-- Down Migration

DROP TABLE aviator_rounds;
DROP TABLE aviator_wallets;
DROP TABLE betting_tips;
