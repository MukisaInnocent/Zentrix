import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, liveOnlyKeys, loadConfig } from '../../src/config/env.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/zentrix',
  CSRF_SECRET: 'c'.repeat(40),
  DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
};

describe('configuration', () => {
  it('defaults to test mode with safe local settings', () => {
    const c = loadConfig(base);
    expect(c.appMode).toBe('test');
    expect(c.cookieSecure).toBe(false);
    expect(c.publicOrigin).toBe('http://localhost:3000');
    expect(c.dataEncryptionKey).toHaveLength(32);
  });

  it('reports missing and malformed values', () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...base, DATA_ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow(/32 bytes/);
    expect(() => loadConfig({ ...base, CSRF_SECRET: 'short' })).toThrow(/CSRF_SECRET/);
    expect(() => loadConfig({ ...base, APP_MODE: 'staging' })).toThrow(ConfigError);
  });

  it('refuses to start test mode while live-only secrets are present', () => {
    expect(liveOnlyKeys({ PAYMENT_PROVIDER_LIVE_API_KEY: 'x', LIVERPOOL: 'y', DELIVERY_URL: 'z' })).toEqual(['PAYMENT_PROVIDER_LIVE_API_KEY']);
    expect(() => loadConfig({ ...base, PAYMENT_PROVIDER_LIVE_API_KEY: 'sk_live_123' })).toThrow(/live-only secrets/);
  });

  it('lists every unmet live-mode requirement', () => {
    try {
      loadConfig({ ...base, APP_MODE: 'live', PUBLIC_ORIGIN: 'http://zentrix.example', COOKIE_SECURE: 'false' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect(String(err)).toMatch(/COOKIE_SECURE=false is only allowed/);
    }
    const message = (() => {
      try {
        loadConfig({ ...base, APP_MODE: 'live', PUBLIC_ORIGIN: 'https://zentrix.example' });
        return '';
      } catch (err) {
        return String(err);
      }
    })();
    for (const part of ['NODE_ENV must be production', 'SMTP_URL or RESEND_API_KEY must be set', 'DATABASE_SSL must not be disable']) expect(message).toContain(part);
  });

  it('accepts a complete live configuration', () => {
    const c = loadConfig({
      ...base, APP_MODE: 'live', NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://zentrix.example', SMTP_URL: 'smtp://mail.example:587',
      DATABASE_SSL: 'verify',
    });
    expect(c.cookieSecure).toBe(true);
    expect(() => loadConfig({
      ...base, APP_MODE: 'live', NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://zentrix.example', SMTP_URL: 'smtp://mail.example:587',
      DATABASE_SSL: 'verify', TEST_AUTO_APPROVE: 'true',
    })).toThrow(/TEST_AUTO_APPROVE must be false/);
    expect(() => loadConfig({
      ...base, APP_MODE: 'live', NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://zentrix.example', SMTP_URL: 'smtp://mail.example:587',
      DATABASE_SSL: 'verify', TEST_SUPERADMIN_PASSWORD: 'SuperAdmin-Test-2026',
    })).toThrow(/TEST_SUPERADMIN_PASSWORD must not be set/);
  });
});

describe('AWS settings', () => {
  it('treats an empty MAIL_S3_BUCKET as off, accepts a bucket name and refuses a bad one', () => {
    expect(loadConfig({ ...base, MAIL_S3_BUCKET: '' }).mailS3Bucket).toBeNull();
    expect(loadConfig({ ...base, MAIL_S3_BUCKET: 'pexa-staging-mail-outbox-1' }).mailS3Bucket).toBe('pexa-staging-mail-outbox-1');
    expect(() => loadConfig({ ...base, MAIL_S3_BUCKET: 'Bad_Bucket' })).toThrow(/MAIL_S3_BUCKET/);
    expect(loadConfig({ ...base, DATABASE_CONNECT_TIMEOUT_MS: '25000' }).databaseConnectTimeoutMs).toBe(25000);
  });
});
