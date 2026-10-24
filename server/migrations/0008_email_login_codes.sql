-- Owner request 2026-10-24: the second sign-in step also accepts a 6-digit code emailed to the account's
-- address. The code is stored only as an HMAC, valid for the life of the challenge (5 minutes), single use.

-- Up Migration
ALTER TABLE mfa_challenges ADD COLUMN email_code_hash bytea;

-- Down Migration
ALTER TABLE mfa_challenges DROP COLUMN email_code_hash;
