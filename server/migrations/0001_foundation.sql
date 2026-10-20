-- Foundation: database mode stamp, shared trigger helpers and the restricted application role.

-- Up Migration

-- One row saying whether this database belongs to a test or a live deployment (decision D19).
-- Written once by the migrate step from APP_MODE, never changed afterwards.
CREATE TABLE system_meta (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  database_mode text NOT NULL CHECK (database_mode IN ('test', 'live')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Rejects UPDATE, DELETE and TRUNCATE on append-only tables. SQLSTATE ZX001 lets the app recognise it.
CREATE FUNCTION zx_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'zentrix: % on % is not allowed, the table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'ZX001';
END
$$;

CREATE FUNCTION zx_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER system_meta_append_only BEFORE UPDATE OR DELETE ON system_meta
  FOR EACH ROW EXECUTE FUNCTION zx_forbid_mutation();
CREATE TRIGGER system_meta_no_truncate BEFORE TRUNCATE ON system_meta
  FOR EACH STATEMENT EXECUTE FUNCTION zx_forbid_mutation();

CREATE FUNCTION zx_app_role_exists() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zentrix_app')
$$;

-- Restricted role the web and worker processes switch to with SET ROLE (decision D10). Tables get
-- SELECT/INSERT/UPDATE/DELETE by default; later migrations revoke rights on protected tables.
-- Hosts that refuse CREATE ROLE skip this layer, and the triggers still protect the data (risk R9).
DO $$
BEGIN
  IF NOT zx_app_role_exists() THEN
    CREATE ROLE zentrix_app NOLOGIN;
  END IF;
  EXECUTE format('GRANT zentrix_app TO %I', current_user);
  GRANT USAGE ON SCHEMA public TO zentrix_app;
  GRANT SELECT ON system_meta TO zentrix_app;
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO zentrix_app', current_user);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO zentrix_app', current_user);
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'zentrix: role zentrix_app not created (%). Privilege separation is off; triggers still apply.', SQLERRM;
END
$$;

-- Down Migration

DROP FUNCTION zx_app_role_exists();
DROP TABLE system_meta;
DROP FUNCTION zx_touch_updated_at();
DROP FUNCTION zx_forbid_mutation();
