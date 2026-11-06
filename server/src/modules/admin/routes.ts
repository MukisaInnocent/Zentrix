import { Router } from 'express';
import type { Services } from '../../services.js';
import { chatsAdminRouter } from './chats.js';
import { configAdminRouter } from './config.js';
import { announcementsAdminRouter } from './announcements.js';
import { emailTemplatesAdminRouter } from './email-templates.js';
import { emailsAdminRouter } from './emails.js';
import { eventsAdminRouter } from './events.js';
import { ebooksAdminRouter } from '../ebooks/routes.js';
import { membersRouter } from './members.js';
import { paymentsAdminRouter } from './payments.js';
import { systemRouter } from './system.js';
import { tasksAdminRouter } from '../tasks/admin.js';
import { videosAdminRouter } from '../videos/routes.js';
import { tipsAdminRouter } from '../tips/routes.js';
import { aviatorAdminRouter } from '../aviator/routes.js';

// Every route below checks a staff role and a TOTP-verified session (requireStaff), and every change
// writes the audit log in the same transaction.
export function adminRouter(services: Services): Router {
  const router = Router();
  router.use('/members', membersRouter(services));
  router.use('/payments', paymentsAdminRouter(services));
  router.use('/chats', chatsAdminRouter(services));
  router.use('/emails', emailsAdminRouter(services));
  router.use('/email-templates', emailTemplatesAdminRouter(services));
  router.use('/announcements', announcementsAdminRouter(services));
  router.use('/ebooks', ebooksAdminRouter(services));
  router.use('/tasks', tasksAdminRouter(services));
  router.use('/videos', videosAdminRouter(services));
  router.use('/tips', tipsAdminRouter(services));
  router.use('/aviator', aviatorAdminRouter(services));
  router.use('/events', eventsAdminRouter(services));
  router.use('/', configAdminRouter(services));
  router.use('/', systemRouter(services));
  return router;
}
