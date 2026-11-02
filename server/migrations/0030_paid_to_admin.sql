-- Owner, 2026-11-02: an admin can activate a member who paid the admin directly (cash, a transfer to the admin's
-- own phone). The payment is recorded on a "Paid to admin" method per country and currency, made by the system the
-- first time it is used: never shown to members, never used for payouts. Its ledger balance is the money staff hold
-- for the platform; moving it to another method is a channel transfer in Treasury.

-- Up Migration

ALTER TABLE payment_channels ADD COLUMN admin_only boolean NOT NULL DEFAULT false;
ALTER TABLE payment_channels ADD CONSTRAINT payment_channels_admin_only
  CHECK (NOT admin_only OR (provider IS NULL AND pay_url IS NULL AND NOT deposits_enabled AND NOT payouts_enabled));

-- Down Migration

ALTER TABLE payment_channels DROP CONSTRAINT payment_channels_admin_only;
ALTER TABLE payment_channels DROP COLUMN admin_only;
