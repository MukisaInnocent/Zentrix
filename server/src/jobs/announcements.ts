import { sendAnnouncementPortion } from '../modules/email/announcements.js';
import type { Job } from './runner.js';

// Hourly (owner, 2026-11-11; daily before): sends the waiting announcement emails within the email allowance, at
// most 1,000 a run and for at most 90 seconds (the AWS jobs function stops after 2 minutes). On AWS a separate
// schedule runs it; the hourly balance check wakes the database anyway.
export const announcementsJob: Job = {
  name: 'announcements',
  schedule: '10 * * * *',
  async run(services) {
    const sent = await sendAnnouncementPortion(services, 1_000, Date.now() + 90_000, { lockHeld: true }); // the runner holds the lock
    if (sent > 0) services.logger.info({ sent }, 'announcement emails sent');
  },
};
