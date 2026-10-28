import { sendAnnouncementPortion } from '../modules/email/announcements.js';
import type { Job } from './runner.js';

// Daily, just after the email allowance resets (owner, 2026-10-29): sends the announcement emails that did not
// fit in earlier days' allowance, at most 1,000 a run (the AWS jobs function stops after 2 minutes). On AWS a
// separate daily schedule runs it, so the database is not woken more often.
export const announcementsJob: Job = {
  name: 'announcements',
  schedule: '10 0 * * *',
  async run(services) {
    const sent = await sendAnnouncementPortion(services, 1_000);
    if (sent > 0) services.logger.info({ sent }, 'announcement emails sent');
  },
};
