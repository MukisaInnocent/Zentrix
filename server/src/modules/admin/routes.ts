import { Router } from 'express';
import type { Services } from '../../services.js';
import { membersRouter } from './members.js';
import { systemRouter } from './system.js';

// Every route below checks a staff role and a TOTP-verified session (requireStaff), and every change
// writes the audit log in the same transaction.
export function adminRouter(services: Services): Router {
  const router = Router();
  router.use('/members', membersRouter(services));
  router.use('/', systemRouter(services));
  return router;
}
