import type { Job } from './runner.js';

// Retention (section 11, data minimisation): expired security tokens go after 7 days, sessions 30 days
// after they end, auth events after 180 days, the test-mode outbox after 14 days, and idempotency keys after 7 days.
export const cleanupJob: Job = {
  name: 'cleanup',
  schedule: '17 3 * * *',
  async run({ pool }) {
    await pool.query(`DELETE FROM sessions WHERE coalesce(revoked_at, expires_at) < now() - interval '30 days'`);
    await pool.query(`DELETE FROM mfa_challenges WHERE expires_at < now() - interval '1 day'`);
    await pool.query(`DELETE FROM email_verifications WHERE expires_at < now() - interval '7 days'`);
    await pool.query(`DELETE FROM phone_verifications WHERE expires_at < now() - interval '7 days'`);
    await pool.query(`DELETE FROM password_resets WHERE expires_at < now() - interval '7 days'`);
    await pool.query(`DELETE FROM rate_limits WHERE reset_at < now()`);
    await pool.query(`DELETE FROM dev_outbox WHERE created_at < now() - interval '14 days'`);
    await pool.query(`DELETE FROM auth_events WHERE created_at < now() - interval '180 days'`);
    await pool.query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '7 days'`);
  },
};
