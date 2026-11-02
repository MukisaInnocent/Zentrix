-- Owner, 2026-11-02: the password reset email also carries a 6-digit code, typed on the Forgot password page, for
-- members whose email app opens the link somewhere else. The code is stored as a keyed hash and allows 5 tries.

-- Up Migration

ALTER TABLE password_resets
  ADD COLUMN code_hash bytea,
  ADD COLUMN attempts smallint NOT NULL DEFAULT 0;
CREATE INDEX password_resets_user_idx ON password_resets (user_id, created_at DESC);

-- Down Migration

DROP INDEX password_resets_user_idx;
ALTER TABLE password_resets DROP COLUMN attempts, DROP COLUMN code_hash;
