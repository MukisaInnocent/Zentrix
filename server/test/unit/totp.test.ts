import { Secret, TOTP } from 'otpauth';
import { describe, expect, it } from 'vitest';
import { totpCodeAt, verifyTotp } from '../../src/modules/auth/totp.js';

// RFC 6238 appendix B vectors for HMAC-SHA1 (8 digits, 30 s steps, ASCII secret "12345678901234567890").
const RFC_SECRET = Secret.fromLatin1('12345678901234567890');
const VECTORS: [number, string][] = [
  [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
  [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
];

describe('TOTP', () => {
  it('matches the RFC 6238 SHA-1 test vectors', () => {
    for (const [seconds, expected] of VECTORS) {
      expect(TOTP.generate({ secret: RFC_SECRET, algorithm: 'SHA1', digits: 8, period: 30, timestamp: seconds * 1000 })).toBe(expected);
    }
  });

  const secret = new Secret({ size: 20 }).base32;
  const at = new Date(1_800_000_000_000);
  const step = Math.floor(at.getTime() / 30_000);

  it('accepts the current step and one either side, and returns the matched step', () => {
    expect(verifyTotp(secret, totpCodeAt(secret, at), null, at)).toBe(step);
    expect(verifyTotp(secret, totpCodeAt(secret, new Date(at.getTime() - 30_000)), null, at)).toBe(step - 1);
    expect(verifyTotp(secret, totpCodeAt(secret, new Date(at.getTime() + 30_000)), null, at)).toBe(step + 1);
    expect(verifyTotp(secret, totpCodeAt(secret, new Date(at.getTime() + 90_000)), null, at)).toBeNull();
  });

  it('refuses replays and malformed codes', () => {
    const code = totpCodeAt(secret, at);
    expect(verifyTotp(secret, code, step, at)).toBeNull();
    expect(verifyTotp(secret, code, step - 1, at)).toBe(step);
    expect(verifyTotp(secret, `${code} `, null, at)).toBeNull();
    expect(verifyTotp(secret, '12345', null, at)).toBeNull();
  });
});
