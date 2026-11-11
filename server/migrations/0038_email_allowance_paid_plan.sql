-- Owner, 2026-11-11: the Resend account was upgraded to a paid plan before launch, but the email allowance setting
-- still held the free plan's numbers (100 a day, 3,000 a month), which held announcements back. A new version of
-- the setting with Resend Pro's allowance (50,000 a month, no daily cap); 200 a day stay free for members' own
-- emails. Admins can change it in the staff console (Settings, Email allowance). TODO(owner): confirm the plan.

-- Up Migration

INSERT INTO settings (key, value, version, note)
SELECT 'email.allowance', '{"daily": 50000, "monthly": 50000, "reserved": 200}'::jsonb, coalesce(max(version), 0) + 1,
       'Owner 2026-11-11: Resend paid plan (Pro, 50,000 a month)'
FROM settings WHERE key = 'email.allowance';

-- Down Migration

SELECT 1;
