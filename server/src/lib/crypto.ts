import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export const sha256 = (value: string | Buffer): Buffer => createHash('sha256').update(value).digest();

export const hmacSha256 = (key: string | Buffer, value: string | Buffer): Buffer =>
  createHmac('sha256', key).update(value).digest();

export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// Digits for one-time codes, drawn with a CSPRNG.
export function randomDigits(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String(randomInt(0, 10));
  return out;
}

// Codes people read and type: no 0/O, 1/I/L.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function randomCode(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  return out;
}

// AES-256-GCM for secrets that must be stored (TOTP seeds). Layout: version(1) | iv(12) | tag(16) | ciphertext.
const ENC_VERSION = 1;
export function encryptSecret(key: Buffer, plaintext: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([ENC_VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptSecret(key: Buffer, payload: Buffer): Buffer {
  if (payload.length < 30 || payload[0] !== ENC_VERSION) throw new Error('Unsupported encrypted payload.');
  const iv = payload.subarray(1, 13);
  const tag = payload.subarray(13, 29);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(payload.subarray(29)), decipher.final()]);
}
