-- Owner, 2026-11-02: a member's registered number counts as verified until it is changed (a change by an admin or
-- an unlocked member change already marks the new number verified). Withdrawals still go only to that number.
-- Members who signed up before this get their registered number marked verified now, with an auth event each.

-- Up Migration

WITH v AS (
  UPDATE users SET phone_verified_at = now() WHERE phone_e164 IS NOT NULL AND phone_verified_at IS NULL RETURNING id
)
INSERT INTO auth_events (user_id, kind, details) SELECT id, 'phone_verified', '{"by":"registered_number"}' FROM v;

-- Down Migration

-- Nothing to undo: the numbers stay verified.
SELECT 1;
