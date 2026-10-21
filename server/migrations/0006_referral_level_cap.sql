-- Referral rewards stop at level 3. NOT VALID leaves any older rows from earlier test data alone
-- and enforces the cap on every new or updated row.

-- Up Migration
ALTER TABLE referral_rewards
  ADD CONSTRAINT referral_rewards_level_max CHECK (level BETWEEN 1 AND 3) NOT VALID;
