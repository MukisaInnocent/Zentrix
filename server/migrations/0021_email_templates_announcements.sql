-- Owner, 2026-10-29: admins edit the wording of the automatic emails and write announcements to members.
-- Templates are versioned like settings (a new row per change, the newest applies; a null content means the
-- built-in default). Announcements are sent in daily portions so members' own emails always fit in the email
-- provider's daily allowance (settings email.daily_limit and email.reserved_daily). Members can turn
-- announcements off.

-- Up Migration

ALTER TABLE email_messages DROP CONSTRAINT email_messages_category_check;
ALTER TABLE email_messages ADD CONSTRAINT email_messages_category_check
  CHECK (category IN ('security', 'payment', 'account', 'referral', 'sign_in', 'announcement'));

ALTER TABLE email_preferences ADD COLUMN announcements boolean NOT NULL DEFAULT true;

CREATE TABLE email_templates (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind ~ '^[a-z_]{3,40}$'),
  version integer NOT NULL CHECK (version > 0),
  -- { subject, heading, body, buttonLabel }, or null to go back to the built-in wording.
  content jsonb,
  note text NOT NULL CHECK (length(note) BETWEEN 3 AND 300),
  created_by bigint NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, version)
);
CREATE TRIGGER email_templates_append_only BEFORE UPDATE OR DELETE ON email_templates FOR EACH ROW EXECUTE FUNCTION zx_forbid_mutation();
CREATE VIEW current_email_templates AS
  SELECT DISTINCT ON (kind) kind, version, content, note, created_by, created_at FROM email_templates ORDER BY kind, version DESC;
COMMENT ON TABLE email_templates IS 'Admin wording for the automatic emails, one version per change. The newest version applies.';

CREATE TABLE announcements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  subject text NOT NULL CHECK (length(subject) BETWEEN 3 AND 150),
  heading text NOT NULL CHECK (length(heading) BETWEEN 1 AND 150),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  button_label text CHECK (length(button_label) BETWEEN 1 AND 40),
  button_url text CHECK (button_url ~ '^https://' AND length(button_url) <= 500),
  CHECK ((button_label IS NULL) = (button_url IS NULL)),
  audience text NOT NULL CHECK (audience IN ('all', 'activated', 'not_activated')),
  country_code char(2) REFERENCES countries (code),
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'done', 'cancelled')),
  recipients integer NOT NULL CHECK (recipients >= 0),
  created_by bigint NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
COMMENT ON TABLE announcements IS 'Messages admins wrote to members. Sent in daily portions within the email allowance.';

CREATE TABLE announcement_recipients (
  announcement_id bigint NOT NULL REFERENCES announcements (id),
  user_id bigint NOT NULL REFERENCES users (id),
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'sent', 'skipped')),
  -- What sendEmail answered (sent, opted_out, suppressed, ...).
  outcome text CHECK (length(outcome) <= 20),
  sent_at timestamptz,
  PRIMARY KEY (announcement_id, user_id)
);
CREATE INDEX announcement_recipients_waiting_idx ON announcement_recipients (announcement_id, user_id) WHERE status = 'waiting';

DO $$
BEGIN
  IF zx_app_role_exists() THEN
    REVOKE TRUNCATE ON email_templates, announcements, announcement_recipients FROM zentrix_app;
    REVOKE DELETE ON announcements, announcement_recipients FROM zentrix_app;
  END IF;
END
$$;

-- Down Migration

DROP TABLE announcement_recipients;
DROP TABLE announcements;
DROP VIEW current_email_templates;
DROP TABLE email_templates;
ALTER TABLE email_preferences DROP COLUMN announcements;
DELETE FROM email_messages WHERE category = 'announcement';
ALTER TABLE email_messages DROP CONSTRAINT email_messages_category_check;
ALTER TABLE email_messages ADD CONSTRAINT email_messages_category_check
  CHECK (category IN ('security', 'payment', 'account', 'referral', 'sign_in'));
