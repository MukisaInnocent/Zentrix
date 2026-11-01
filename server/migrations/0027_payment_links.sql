-- Owner, 2026-11-01: admins can add payment methods that members pay through a link (a payment page on any https
-- host) as well as direct transfers (bank or mobile money, already possible). The member pays on the link, then
-- claims with the transaction reference and staff approve it by hand, like any manual method.

-- Up Migration

ALTER TABLE payment_channels
  ADD COLUMN pay_url text CHECK (pay_url IS NULL OR (pay_url ~ '^https://' AND length(pay_url) <= 500));

-- Down Migration

ALTER TABLE payment_channels DROP COLUMN pay_url;
