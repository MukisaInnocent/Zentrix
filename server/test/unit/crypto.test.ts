import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseCookies } from '../../src/http/cookies.js';
import { decryptSecret, encryptSecret, randomCode, randomDigits, randomToken } from '../../src/lib/crypto.js';

describe('secret encryption', () => {
  const key = randomBytes(32);
  it('round-trips and uses a fresh IV each time', () => {
    const a = encryptSecret(key, Buffer.from('JBSWY3DPEHPK3PXP'));
    const b = encryptSecret(key, Buffer.from('JBSWY3DPEHPK3PXP'));
    expect(a.equals(b)).toBe(false);
    expect(decryptSecret(key, a).toString()).toBe('JBSWY3DPEHPK3PXP');
  });
  it('detects tampering and wrong keys', () => {
    const sealed = encryptSecret(key, Buffer.from('secret'));
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => decryptSecret(key, tampered)).toThrow();
    expect(() => decryptSecret(randomBytes(32), sealed)).toThrow();
  });
});

describe('random values', () => {
  it('produce the expected shapes', () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomDigits(6)).toMatch(/^[0-9]{6}$/);
    expect(randomCode(8)).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  });
});

describe('parseCookies', () => {
  it('handles spacing, quotes, duplicates and malformed values', () => {
    const c = parseCookies('a=1; b="two" ;c=%E2%9C%93; a=ignored; bad=%E0%A4%A; =nameless; flag');
    expect(Object.fromEntries(c)).toEqual({ a: '1', b: 'two', c: '✓' });
    expect(parseCookies(undefined).size).toBe(0);
  });
});
