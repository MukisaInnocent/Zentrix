-- Up Migration

-- Aviator house limit (owner, 2026-11-16). The house has a bankroll (hundredths of a credit) that admins set in the
-- staff console; every bet adds its stake and every cash-out takes its payout. When paying the players still in the
-- air would take the bankroll below the floor (default 10,000 credits), the round ends at that multiplier and those
-- bets lose. The rule is shown to members. A NULL bankroll means no house limit (as before).
ALTER TABLE aviator_settings
  ADD COLUMN bankroll bigint,
  ADD COLUMN bankroll_floor bigint NOT NULL DEFAULT 1000000 CHECK (bankroll_floor >= 0);

-- limit_point: where the house limit ends the round, when that is below the seed's crash point. crash_point stays the
-- seed's value, so the fairness check still verifies it; the round ends at the lower of the two.
ALTER TABLE aviator_rounds
  ADD COLUMN limit_point numeric(10, 2) CHECK (limit_point >= 1 AND limit_point <= 10000);

-- Down Migration

ALTER TABLE aviator_rounds DROP COLUMN limit_point;
ALTER TABLE aviator_settings DROP COLUMN bankroll_floor, DROP COLUMN bankroll;
