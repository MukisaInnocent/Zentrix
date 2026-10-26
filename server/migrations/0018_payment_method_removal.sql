-- Owner, 2026-10-26: admins add, edit and remove the payment methods each country's members see on the activation
-- and deposit pages. Deposits, withdrawals and the ledger keep pointing at a method, so removing one archives it:
-- members no longer see it, it takes no deposits and sends no payouts, and an admin can restore it.

-- Up Migration

ALTER TABLE payment_channels ADD COLUMN removed_at timestamptz;
ALTER TABLE payment_channels ADD CONSTRAINT payment_channels_removed_off
  CHECK (removed_at IS NULL OR (NOT deposits_enabled AND NOT payouts_enabled));

-- Down Migration

ALTER TABLE payment_channels DROP CONSTRAINT payment_channels_removed_off;
ALTER TABLE payment_channels DROP COLUMN removed_at;
