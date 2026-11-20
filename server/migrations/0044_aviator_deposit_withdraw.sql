-- Up Migration

-- Owner, 2026-11-20: members deposit straight into their Aviator balance (deposits.purpose 'aviator', credited to
-- member_aviator) and withdraw straight from it (withdrawals.source 'aviator'), with the same withdrawal limits and
-- charges. Aviator money can be withdrawn at any time: the bet-first rule (aviator_wagering) is dropped; the table
-- stays, unused.
ALTER TABLE deposits DROP CONSTRAINT deposits_purpose_check;
ALTER TABLE deposits ADD CONSTRAINT deposits_purpose_check CHECK (purpose IN ('activation', 'wallet', 'aviator'));
ALTER TABLE withdrawals DROP CONSTRAINT withdrawals_source_check;
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_source_check
  CHECK (source IN ('main', 'youtube', 'tiktok', 'ads', 'trivia', 'fixtap', 'music', 'chat', 'aviator'));

-- Down Migration

ALTER TABLE withdrawals DROP CONSTRAINT withdrawals_source_check;
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_source_check CHECK (source IN ('main', 'youtube', 'tiktok', 'ads', 'trivia', 'fixtap', 'music'));
ALTER TABLE deposits DROP CONSTRAINT deposits_purpose_check;
ALTER TABLE deposits ADD CONSTRAINT deposits_purpose_check CHECK (purpose IN ('activation', 'wallet'));
