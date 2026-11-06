-- Up Migration

-- Aviator update from the owner's project (owner, 2026-11-06, later): provably fair rounds, admin game settings, instant
-- demo credits and balance adjustments by staff.

-- Provably fair: sha256(server_seed) is shown while members bet; the seed is shown once the round has crashed.
-- Each round keeps the house edge and climb speed it was played with. Rounds from before have no seed.
ALTER TABLE aviator_rounds
  ADD COLUMN server_seed text,
  ADD COLUMN hash text,
  ADD COLUMN house_edge double precision,
  ADD COLUMN growth_rate double precision,
  DROP CONSTRAINT aviator_rounds_crash_point_check,
  ADD CONSTRAINT aviator_rounds_crash_point_check CHECK (crash_point >= 1 AND crash_point <= 10000);

-- One row of game settings, edited by admins in the staff console. Amounts are hundredths of a credit.
CREATE TABLE aviator_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  betting_seconds integer NOT NULL DEFAULT 8 CHECK (betting_seconds BETWEEN 3 AND 60),
  crash_display_seconds integer NOT NULL DEFAULT 3 CHECK (crash_display_seconds BETWEEN 1 AND 30),
  growth_rate double precision NOT NULL DEFAULT 1.1 CHECK (growth_rate BETWEEN 1.01 AND 1.5),
  house_edge double precision NOT NULL DEFAULT 0.01 CHECK (house_edge BETWEEN 0 AND 0.2),
  min_bet bigint NOT NULL DEFAULT 1 CHECK (min_bet > 0),
  max_bet bigint NOT NULL DEFAULT 1000000 CHECK (max_bet >= min_bet),
  max_win bigint NOT NULL DEFAULT 100000000 CHECK (max_win >= max_bet),
  paused boolean NOT NULL DEFAULT false,
  pause_message text CHECK (char_length(pause_message) <= 200),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint REFERENCES users (id)
);
INSERT INTO aviator_settings (id) VALUES (1);

-- Demo credits now apply at once (status completed); staff adjustments are recorded here too, with a reason.
-- Older pending requests can still be approved or rejected.
ALTER TABLE aviator_requests
  DROP CONSTRAINT aviator_requests_kind_check,
  ADD CONSTRAINT aviator_requests_kind_check CHECK (kind IN ('deposit', 'withdrawal', 'adjustment')),
  DROP CONSTRAINT aviator_requests_status_check,
  ADD CONSTRAINT aviator_requests_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'completed')),
  ADD COLUMN balance_before bigint,
  ADD COLUMN balance_after bigint,
  ADD COLUMN reason text CHECK (char_length(reason) <= 200);
CREATE INDEX aviator_requests_user_idx ON aviator_requests (user_id, id DESC);
CREATE INDEX aviator_bets_created_idx ON aviator_bets (created_at) WHERE result <> 'pending';

DO $$
BEGIN
  IF zx_app_role_exists() THEN
    GRANT SELECT, UPDATE ON aviator_settings TO zentrix_app;
    REVOKE INSERT, DELETE, TRUNCATE ON aviator_settings FROM zentrix_app;
  END IF;
END
$$;

-- Down Migration

DROP INDEX aviator_bets_created_idx;
DROP INDEX aviator_requests_user_idx;
ALTER TABLE aviator_requests DROP COLUMN reason, DROP COLUMN balance_after, DROP COLUMN balance_before;
DROP TABLE aviator_settings;
ALTER TABLE aviator_rounds DROP COLUMN growth_rate, DROP COLUMN house_edge, DROP COLUMN hash, DROP COLUMN server_seed;
