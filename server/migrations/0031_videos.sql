-- Owner, 2026-11-03: admins add videos for members to watch, as links to YouTube, TikTok or any other site (no file
-- uploads). Links to adult content are refused by the server. Videos pay nothing; they are only to watch. Members see
-- published videos; removing a video archives it.

-- Up Migration

CREATE TABLE videos (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 600),
  link_url text NOT NULL CHECK (link_url ~ '^https://' AND length(link_url) <= 500),
  published boolean NOT NULL DEFAULT true,
  sort integer NOT NULL DEFAULT 0 CHECK (sort BETWEEN 0 AND 10000),
  created_by bigint NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz
);
CREATE INDEX videos_list_idx ON videos (sort, id) WHERE removed_at IS NULL;
CREATE TRIGGER videos_touch BEFORE UPDATE ON videos FOR EACH ROW EXECUTE FUNCTION zx_touch_updated_at();
COMMENT ON TABLE videos IS 'Videos on the member Videos page (links only), managed by admins. removed_at archives a video.';

DO $$
BEGIN
  IF zx_app_role_exists() THEN
    GRANT SELECT, INSERT, UPDATE ON videos TO zentrix_app;
    REVOKE DELETE, TRUNCATE ON videos FROM zentrix_app;
  END IF;
END
$$;

-- Down Migration

DROP TABLE videos;
