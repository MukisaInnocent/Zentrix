-- Owner, 2026-10-26:
-- 1. There is no monthly withdrawal limit, so the column goes (the per-request and daily maximums stay).
-- 2. Chat between members, free of charge and never a way to move money. Two kinds of conversation:
--    'invite'   between a member and the person who invited them, or someone they invited directly;
--    'foreign'  with a random activated member from another country ("Random match").
--    Members see usernames only. A member can block someone and report a conversation; staff read a
--    conversation only through a report, and every staff read is audited.

-- Up Migration

DROP VIEW current_country_configs;
ALTER TABLE country_configs DROP COLUMN withdrawal_monthly_max_minor;
CREATE VIEW current_country_configs AS
  SELECT DISTINCT ON (country_code) * FROM country_configs ORDER BY country_code, version DESC;

-- One conversation per pair of members; user_a_id is always the smaller id.
CREATE TABLE chat_conversations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('invite', 'foreign')),
  user_a_id bigint NOT NULL REFERENCES users (id),
  user_b_id bigint NOT NULL REFERENCES users (id),
  -- The last message each side has seen, for unread counts.
  a_last_read_id bigint NOT NULL DEFAULT 0,
  b_last_read_id bigint NOT NULL DEFAULT 0,
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_a_id < user_b_id),
  UNIQUE (user_a_id, user_b_id)
);
CREATE INDEX chat_conversations_b_idx ON chat_conversations (user_b_id);

CREATE TABLE chat_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id bigint NOT NULL REFERENCES chat_conversations (id),
  sender_user_id bigint NOT NULL REFERENCES users (id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_conversation_idx ON chat_messages (conversation_id, id);
CREATE INDEX chat_messages_sender_idx ON chat_messages (sender_user_id, created_at);
CREATE TRIGGER chat_messages_append_only BEFORE UPDATE OR DELETE ON chat_messages FOR EACH ROW EXECUTE FUNCTION zx_forbid_mutation();

CREATE TABLE chat_blocks (
  blocker_user_id bigint NOT NULL REFERENCES users (id),
  blocked_user_id bigint NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_user_id, blocked_user_id),
  CHECK (blocker_user_id <> blocked_user_id)
);

CREATE TABLE chat_reports (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  conversation_id bigint NOT NULL REFERENCES chat_conversations (id),
  reporter_user_id bigint NOT NULL REFERENCES users (id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 5 AND 500),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_by bigint REFERENCES users (id),
  closed_at timestamptz,
  closing_note text CHECK (length(closing_note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'closed') = (closed_by IS NOT NULL AND closed_at IS NOT NULL))
);
CREATE INDEX chat_reports_status_idx ON chat_reports (status, created_at);
-- One open report per member per conversation.
CREATE UNIQUE INDEX chat_reports_open_once ON chat_reports (conversation_id, reporter_user_id) WHERE status = 'open';

DO $$
BEGIN
  IF zx_app_role_exists() THEN
    GRANT SELECT ON current_country_configs TO zentrix_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON chat_messages FROM zentrix_app;
    REVOKE DELETE, TRUNCATE ON chat_conversations, chat_reports FROM zentrix_app;
    REVOKE TRUNCATE ON chat_blocks FROM zentrix_app;
  END IF;
END
$$;

-- Down Migration

DROP TABLE chat_reports;
DROP TABLE chat_blocks;
DROP TABLE chat_messages;
DROP TABLE chat_conversations;
DROP VIEW current_country_configs;
-- country_configs is append-only, so the restored column is filled by its default (no monthly cap).
ALTER TABLE country_configs ADD COLUMN withdrawal_monthly_max_minor bigint NOT NULL DEFAULT 9223372036854775807;
CREATE VIEW current_country_configs AS
  SELECT DISTINCT ON (country_code) * FROM country_configs ORDER BY country_code, version DESC;
