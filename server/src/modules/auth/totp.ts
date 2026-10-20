import { Secret, TOTP } from 'otpauth';
import { decryptSecret, encryptSecret, hmacSha256 } from '../../lib/crypto.js';

const ISSUER = 'Zentrix';
const PERIOD = 30;

export function newTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

function totpFor(secretBase32: string, label: string): TOTP {
  return new TOTP({ issuer: ISSUER, label, secret: Secret.fromBase32(secretBase32), algorithm: 'SHA1', digits: 6, period: PERIOD });
}

export function otpauthUrl(secretBase32: string, label: string): string {
  return totpFor(secretBase32, label).toString();
}

export function totpCodeAt(secretBase32: string, at: Date): string {
  return totpFor(secretBase32, 'code').generate({ timestamp: at.getTime() });
}

// Accepts the current 30-second step and one step either side. Returns the matched step, or null.
// A step at or before lastUsedStep is refused, so a code cannot be replayed.
export function verifyTotp(secretBase32: string, code: string, lastUsedStep: number | null, at: Date): number | null {
  if (!/^[0-9]{6}$/.test(code)) return null;
  const delta = totpFor(secretBase32, 'code').validate({ token: code, timestamp: at.getTime(), window: 1 });
  if (delta === null) return null;
  const step = TOTP.counter({ period: PERIOD, timestamp: at.getTime() }) + delta;
  if (lastUsedStep !== null && step <= lastUsedStep) return null;
  return step;
}

export const sealTotpSecret = (key: Buffer, secretBase32: string): Buffer => encryptSecret(key, Buffer.from(secretBase32, 'utf8'));
export const openTotpSecret = (key: Buffer, sealed: Buffer): string => decryptSecret(key, sealed).toString('utf8');

// Recovery codes and one-time codes are stored as keyed hashes, so a database leak alone does not let
// anyone brute-force them offline.
export function codeHash(masterKey: Buffer, purpose: string, value: string): Buffer {
  return hmacSha256(hmacSha256(masterKey, `zentrix:${purpose}`), value);
}

export const normaliseRecoveryCode = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
