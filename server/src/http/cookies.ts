import type { Request, Response } from 'express';
import type { Config } from '../config/env.js';

export interface CookieNames {
  session: string;
  csrf: string;
}

// __Host- prefixed cookies (Secure, Path=/, no Domain) whenever cookies are Secure (decision D12).
export function cookieNames(config: Config): CookieNames {
  const prefix = config.cookieSecure ? '__Host-' : '';
  return { session: `${prefix}zx_session`, csrf: `${prefix}zx_csrf` };
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (name === '' || out.has(name)) continue;
    try {
      out.set(name, decodeURIComponent(value));
    } catch {
      // Ignore malformed cookie values.
    }
  }
  return out;
}

export function readCookie(req: Request, name: string): string | undefined {
  return parseCookies(req.headers.cookie).get(name);
}

export function setAuthCookies(res: Response, config: Config, token: string, csrfToken: string, maxAgeMs: number): void {
  const names = cookieNames(config);
  res.cookie(names.session, token, { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/', maxAge: maxAgeMs });
  res.cookie(names.csrf, csrfToken, { httpOnly: false, secure: config.cookieSecure, sameSite: 'strict', path: '/', maxAge: maxAgeMs });
}

export function clearAuthCookies(res: Response, config: Config): void {
  const names = cookieNames(config);
  res.clearCookie(names.session, { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/' });
  res.clearCookie(names.csrf, { httpOnly: false, secure: config.cookieSecure, sameSite: 'strict', path: '/' });
}
