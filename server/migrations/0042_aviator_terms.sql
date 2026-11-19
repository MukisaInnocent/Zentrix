-- Up Migration

-- Aviator terms (owner, 2026-11-19): a member accepts the Aviator Terms and Conditions (/aviator-terms) before
-- betting. One row per member and terms version; a new version needs a new acceptance.
CREATE TABLE aviator_terms_acceptances (
  user_id bigint NOT NULL REFERENCES users (id),
  version text NOT NULL CHECK (char_length(version) <= 20),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, version)
);

DO $$
BEGIN
  IF zx_app_role_exists() THEN
    GRANT SELECT, INSERT ON aviator_terms_acceptances TO zentrix_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON aviator_terms_acceptances FROM zentrix_app;
  END IF;
END
$$;

-- Down Migration

DROP TABLE aviator_terms_acceptances;
