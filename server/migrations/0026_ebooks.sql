-- Owner, 2026-11-01: admins manage the E-books page (sections, titles, descriptions, links) instead of the made-up
-- books the page showed. A book links to its file (a PDF on any https host); members see published books, grouped
-- by section. Removing a book archives it.

-- Up Migration

CREATE TABLE ebooks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  section text NOT NULL CHECK (length(section) BETWEEN 2 AND 60),
  title text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  description text NOT NULL CHECK (length(description) BETWEEN 2 AND 600),
  pages integer CHECK (pages BETWEEN 1 AND 5000),
  link_url text NOT NULL CHECK (link_url ~ '^https://' AND length(link_url) <= 500),
  published boolean NOT NULL DEFAULT true,
  sort integer NOT NULL DEFAULT 0 CHECK (sort BETWEEN 0 AND 10000),
  created_by bigint NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz
);
CREATE INDEX ebooks_list_idx ON ebooks (section, sort, id) WHERE removed_at IS NULL;
CREATE TRIGGER ebooks_touch BEFORE UPDATE ON ebooks FOR EACH ROW EXECUTE FUNCTION zx_touch_updated_at();
COMMENT ON TABLE ebooks IS 'E-books on the member E-books page, managed by admins. removed_at archives a book.';

DO $$
BEGIN
  IF zx_app_role_exists() THEN
    GRANT SELECT, INSERT, UPDATE ON ebooks TO zentrix_app;
    REVOKE DELETE, TRUNCATE ON ebooks FROM zentrix_app;
  END IF;
END
$$;

-- Down Migration

DROP TABLE ebooks;
