import type { AuthContext } from '../modules/auth/context.js';

declare global {
  namespace Express {
    interface Request {
      id: string;
      auth?: AuthContext;
    }
  }
}

export {};
