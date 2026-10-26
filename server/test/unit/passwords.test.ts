import { describe, expect, it } from 'vitest';
import { hashPassword, passwordProblems, verifyPassword } from '../../src/modules/auth/passwords.js';

describe('password hashing', () => {
  it('uses argon2id with the OWASP parameters', async () => {
    const hash = await hashPassword('a long passphrase 42');
    expect(hash.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
    expect(await verifyPassword(hash, 'a long passphrase 42')).toBe(true);
    expect(await verifyPassword(hash, 'a long passphrase 43')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });
});

describe('password policy', () => {
  it('requires length and refuses common or personal passwords', () => {
    expect(passwordProblems('short')).not.toHaveLength(0);
    expect(passwordProblems('password123')).not.toHaveLength(0);
    expect(passwordProblems('aaaaaaaaaaaa')).not.toHaveLength(0);
    expect(passwordProblems('kampala_rider_2026', { username: 'rider' })).not.toHaveLength(0);
    expect(passwordProblems('mukisa-secret-77', { email: 'mukisa@example.com' })).not.toHaveLength(0);
    expect(passwordProblems('x'.repeat(129))).not.toHaveLength(0);
    expect(passwordProblems('correct horse battery 9', { username: 'alice', email: 'alice@example.com' })).toEqual([]);
  });

  it('lets members use a short, easy password but makes staff mix letters, numbers and a symbol', () => {
    expect(passwordProblems('sunset')).toEqual([]);
    expect(passwordProblems('kampala')).toEqual([]);
    expect(passwordProblems('12345')).not.toHaveLength(0);
    expect(passwordProblems('123456')).not.toHaveLength(0);
    expect(passwordProblems('qwerty')).not.toHaveLength(0);
    expect(passwordProblems('sunset', { staff: true })).not.toHaveLength(0);
    expect(passwordProblems('sunsetboulevard', { staff: true })).toEqual(['Staff passwords need letters, numbers and at least one symbol.']);
    expect(passwordProblems('sunset-boulevard-7', { staff: true })).toEqual([]);
  });
});
