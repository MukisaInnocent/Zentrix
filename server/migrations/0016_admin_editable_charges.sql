-- Owner, 2026-10-26: admins edit the system's variables from the staff console, including the withdrawal charge
-- table. An edit replaces a currency's bands in one transaction and writes the before and after to audit_log.

-- Up Migration

DO $$
BEGIN
  IF zx_app_role_exists() THEN
    GRANT INSERT, DELETE ON withdrawal_charges TO zentrix_app;
  END IF;
END
$$;

-- Down Migration

DO $$
BEGIN
  IF zx_app_role_exists() THEN
    REVOKE INSERT, DELETE ON withdrawal_charges FROM zentrix_app;
  END IF;
END
$$;
