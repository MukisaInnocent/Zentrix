-- Owner, 2026-10-28: the email system. Every email the site sends is recorded with its delivery status, which
-- Resend reports back through a signed webhook. An address that bounces permanently or reports spam is suppressed
-- (no more mail to it) until staff remove it. Members choose whether they get the optional emails (referral
-- rewards, new sign-in alerts); security and payment emails always go.

-- Up Migration

CREATE TABLE email_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id bigint REFERENCES users (id),
  recipient text NOT NULL CHECK (length(recipient) <= 254),
  kind text NOT NULL CHECK (kind ~ '^[a-z_]{3,40}$'),
  category text NOT NULL CHECK (category IN ('security', 'payment', 'account', 'referral', 'sign_in')),
  subject text NOT NULL CHECK (length(subject) <= 200),
  -- What the email is about, to send it once (for example 'reward:42').
  ref text CHECK (length(ref) <= 80),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sent', 'delayed', 'delivered', 'bounced', 'complained', 'failed', 'skipped', 'suppressed')),
  provider_id text CHECK (length(provider_id) <= 100),
  detail text CHECK (length(detail) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE email_messages IS 'Every email the site sent or skipped, with the delivery status reported by the email provider.';
CREATE INDEX email_messages_created_idx ON email_messages (created_at DESC);
CREATE INDEX email_messages_user_idx ON email_messages (user_id, created_at DESC);
CREATE INDEX email_messages_recipient_idx ON email_messages (lower(recipient));
CREATE UNIQUE INDEX email_messages_once_idx ON email_messages (kind, ref) WHERE ref IS NOT NULL;

CREATE TABLE email_suppressions (
  email text PRIMARY KEY CHECK (email = lower(email) AND length(email) <= 254),
  reason text NOT NULL CHECK (reason IN ('bounced', 'complained')),
  detail text CHECK (length(detail) <= 500),
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE email_suppressions IS 'Addresses that must get no more email (permanent bounce or spam report). Staff can remove one.';

CREATE TABLE email_preferences (
  user_id bigint PRIMARY KEY REFERENCES users (id),
  referral_rewards boolean NOT NULL DEFAULT true,
  sign_in_alerts boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE email_preferences IS 'Optional emails a member chose to get. No row means every optional email is on.';

-- Webhook deliveries already handled (the provider retries, and a replay must change nothing).
CREATE TABLE email_webhook_events (
  id text PRIMARY KEY CHECK (length(id) <= 100),
  received_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF zx_app_role_exists() THEN
    REVOKE TRUNCATE ON email_messages, email_suppressions, email_preferences, email_webhook_events FROM zentrix_app;
    REVOKE DELETE ON email_preferences FROM zentrix_app;
  END IF;
END
$$;

-- Down Migration

DROP TABLE email_webhook_events;
DROP TABLE email_preferences;
DROP TABLE email_suppressions;
DROP TABLE email_messages;
