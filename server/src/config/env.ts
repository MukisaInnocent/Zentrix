import { z } from 'zod';

const base64Key = z
  .string()
  .transform((value, ctx) => {
    const buf = Buffer.from(value, 'base64');
    if (buf.length !== 32) {
      ctx.addIssue({ code: 'custom', message: 'must be 32 bytes, base64-encoded' });
      return z.NEVER;
    }
    return buf;
  });

const EnvSchema = z.object({
  APP_MODE: z.enum(['test', 'live']).default('test'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  PUBLIC_ORIGIN: z.url({ protocol: /^https?$/ }).default('http://localhost:3000'),
  // Other https site addresses that serve the same app and may send state-changing requests, comma-separated
  // (for example the temporary CloudFront link while a custom domain is introduced). PUBLIC_ORIGIN stays the
  // address used in emails.
  EXTRA_ORIGINS: z.string().default(''),
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: z.enum(['disable', 'require', 'verify']).default('disable'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  // How long to wait for a database connection. Aurora Serverless resuming from 0 ACU takes about 15 seconds.
  DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  DATABASE_APP_ROLE: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/).optional(),
  CSRF_SECRET: z.string().min(32, 'CSRF_SECRET must be at least 32 characters'),
  DATA_ENCRYPTION_KEY: base64Key,
  COOKIE_SECURE: z.stringbool().optional(),
  SMTP_URL: z.string().optional(),
  // Resend (https://resend.com) email API key. When set, email goes through its HTTP API instead of SMTP.
  RESEND_API_KEY: z.string().optional(),
  // Signing secret of the Resend webhook that reports delivery (whsec_...). Without it the webhook answers 404.
  RESEND_WEBHOOK_SECRET: z.string().regex(/^$|^whsec_[A-Za-z0-9+/=]{16,}$/).optional(),
  MAIL_FROM: z.string().min(3).default('Pexerearn <info@pexerearn.com>'),
  // AWS: the API runs in a VPC without internet access, so it hands each email to this S3 bucket and a mailer
  // function outside the VPC sends it (docs/DEPLOYMENT.md).
  // Empty means off (Terraform passes an empty value when no email service is set up).
  MAIL_S3_BUCKET: z.string().regex(/^$|^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/).optional(),
  // Exchange rates for referral rewards paid across currencies: the free open.er-api.com endpoint, or (AWS, no
  // internet in the VPC) the snapshot the fetcher function leaves in FX_S3_BUCKET. 'none' stores no rates.
  FX_PROVIDER: z.enum(['open-er-api', 's3', 'none']).default('open-er-api'),
  FX_S3_BUCKET: z.string().regex(/^$|^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/).optional(),
  GEOIP_PROVIDER: z.enum(['none', 'test-header']).default('none'),
  // Mobile-money provider API (owner, 2026-10-30: LivePay). Default: the simulator in test mode, none in live mode.
  // LivePay has no sandbox, so its keys carry LIVE in their names and test mode refuses to start with them.
  PAYMENT_PROVIDER: z.enum(['none', 'simulator', 'livepay']).optional(),
  LIVEPAY_LIVE_API_KEY: z.string().optional(),
  LIVEPAY_LIVE_WEBHOOK_SECRET: z.string().optional(),
  LIVEPAY_ACCOUNT_NUMBER: z.string().regex(/^$|^[A-Za-z0-9]{4,40}$/).optional(),
  LIVEPAY_BASE_URL: z.url({ protocol: /^https$/ }).default('https://livepay.me/api'),
  // The webhook address registered in the LivePay dashboard; it is part of what LivePay signs.
  LIVEPAY_WEBHOOK_URL: z.url({ protocol: /^https?$/ }).optional(),
  // AWS: the API has no internet, so provider commands go through this bucket to the paygate function.
  PAYGATE_S3_BUCKET: z.string().regex(/^$|^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MIGRATE_ON_START: z.stringbool().default(false),
  SEED_ON_START: z.stringbool().default(false),
  // Test mode only: activation payments and withdrawals pass by themselves (owner, 2026-10-25).
  TEST_AUTO_APPROVE: z.stringbool().default(false),
  // Test mode only: the password of the `superadmin` account, which signs in without the second step.
  TEST_SUPERADMIN_PASSWORD: z.string().min(12, { error: 'TEST_SUPERADMIN_PASSWORD must be at least 12 characters.' }).optional(),
  RUN_JOBS_IN_WEB: z.stringbool().default(false),
});

export type AppMode = 'test' | 'live';

export interface Config {
  appMode: AppMode;
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  host: string;
  publicOrigin: string;
  extraOrigins: string[];
  trustProxy: number;
  databaseUrl: string;
  databaseSsl: 'disable' | 'require' | 'verify';
  databasePoolMax: number;
  databaseConnectTimeoutMs: number;
  databaseAppRole: string | null;
  csrfSecret: string;
  dataEncryptionKey: Buffer;
  cookieSecure: boolean;
  smtpUrl: string | null;
  resendApiKey: string | null;
  resendWebhookSecret: string | null;
  mailFrom: string;
  mailS3Bucket: string | null;
  fxProvider: 'open-er-api' | 's3' | 'none';
  fxS3Bucket: string | null;
  geoipProvider: 'none' | 'test-header';
  paymentProvider: 'none' | 'simulator' | 'livepay';
  livepayApiKey: string | null;
  livepayWebhookSecret: string | null;
  livepayAccountNumber: string | null;
  livepayBaseUrl: string;
  livepayWebhookUrl: string;
  paygateS3Bucket: string | null;
  logLevel: string;
  migrateOnStart: boolean;
  seedOnStart: boolean;
  testAutoApprove: boolean;
  testSuperadminPassword: string | null;
  runJobsInWeb: boolean;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

// Live-only secrets follow a naming rule: their variable name contains a LIVE word,
// e.g. PAYMENT_PROVIDER_LIVE_API_KEY. Test mode refuses to start when any is set (section 0).
export function liveOnlyKeys(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter(k => /(^|_)LIVE(_|$)/.test(k) && (env[k] ?? '') !== '');
}

export function isLocalOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
      hostname.endsWith('.local')
    );
  } catch {
    return false;
  }
}

function parseOrigins(raw: string): string[] {
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(value => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ConfigError(`EXTRA_ORIGINS: "${value}" is not a URL.`);
    }
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
      throw new ConfigError(`EXTRA_ORIGINS: "${value}" must be an https origin such as https://example.com.`);
    }
    return url.origin;
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(i => `${i.path.join('.') || 'env'}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n  ${lines.join('\n  ')}`);
  }
  const e = parsed.data;
  const origin = new URL(e.PUBLIC_ORIGIN).origin;
  const config: Config = {
    appMode: e.APP_MODE,
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    publicOrigin: origin,
    extraOrigins: parseOrigins(e.EXTRA_ORIGINS),
    trustProxy: e.TRUST_PROXY,
    databaseUrl: e.DATABASE_URL,
    databaseSsl: e.DATABASE_SSL,
    databasePoolMax: e.DATABASE_POOL_MAX,
    databaseConnectTimeoutMs: e.DATABASE_CONNECT_TIMEOUT_MS,
    databaseAppRole: e.DATABASE_APP_ROLE ?? null,
    csrfSecret: e.CSRF_SECRET,
    dataEncryptionKey: e.DATA_ENCRYPTION_KEY,
    cookieSecure: e.COOKIE_SECURE ?? !isLocalOrigin(origin),
    smtpUrl: e.SMTP_URL && e.SMTP_URL.length > 0 ? e.SMTP_URL : null,
    resendApiKey: e.RESEND_API_KEY && e.RESEND_API_KEY.length > 0 ? e.RESEND_API_KEY : null,
    resendWebhookSecret: e.RESEND_WEBHOOK_SECRET && e.RESEND_WEBHOOK_SECRET.length > 0 ? e.RESEND_WEBHOOK_SECRET : null,
    mailFrom: e.MAIL_FROM,
    mailS3Bucket: e.MAIL_S3_BUCKET && e.MAIL_S3_BUCKET.length > 0 ? e.MAIL_S3_BUCKET : null,
    fxProvider: e.FX_PROVIDER,
    fxS3Bucket: e.FX_S3_BUCKET && e.FX_S3_BUCKET.length > 0 ? e.FX_S3_BUCKET : null,
    geoipProvider: e.GEOIP_PROVIDER,
    paymentProvider: e.PAYMENT_PROVIDER ?? (e.APP_MODE === 'test' ? 'simulator' : 'none'),
    livepayApiKey: e.LIVEPAY_LIVE_API_KEY || null,
    livepayWebhookSecret: e.LIVEPAY_LIVE_WEBHOOK_SECRET || null,
    livepayAccountNumber: e.LIVEPAY_ACCOUNT_NUMBER || null,
    livepayBaseUrl: e.LIVEPAY_BASE_URL,
    livepayWebhookUrl: e.LIVEPAY_WEBHOOK_URL ?? `${origin}/api/webhooks/livepay`,
    paygateS3Bucket: e.PAYGATE_S3_BUCKET || null,
    logLevel: e.LOG_LEVEL,
    migrateOnStart: e.MIGRATE_ON_START,
    seedOnStart: e.SEED_ON_START,
    testAutoApprove: e.TEST_AUTO_APPROVE,
    testSuperadminPassword: e.TEST_SUPERADMIN_PASSWORD ?? null,
    runJobsInWeb: e.RUN_JOBS_IN_WEB,
  };
  assertModeRules(config, env);
  return Object.freeze(config);
}

// Start-up rules that need only the environment. Database-dependent gates live in gates.ts.
export function assertModeRules(config: Config, env: NodeJS.ProcessEnv): void {
  if (!config.cookieSecure && !isLocalOrigin(config.publicOrigin)) {
    throw new ConfigError('COOKIE_SECURE=false is only allowed for a localhost PUBLIC_ORIGIN.');
  }
  if (config.paymentProvider === 'livepay') {
    const missing = [
      !config.livepayWebhookSecret && 'LIVEPAY_LIVE_WEBHOOK_SECRET',
      // With the S3 handoff (AWS) only the paygate function holds the API key and account number.
      !config.paygateS3Bucket && !config.livepayApiKey && 'LIVEPAY_LIVE_API_KEY',
      !config.paygateS3Bucket && !config.livepayAccountNumber && 'LIVEPAY_ACCOUNT_NUMBER',
    ].filter(Boolean);
    if (config.appMode !== 'live') throw new ConfigError('PAYMENT_PROVIDER=livepay moves real money and needs APP_MODE=live (LivePay has no sandbox). Use simulator in test mode.');
    if (missing.length > 0) throw new ConfigError(`PAYMENT_PROVIDER=livepay needs ${missing.join(', ')}.`);
  }
  if (config.appMode === 'test') {
    const live = liveOnlyKeys(env);
    if (live.length > 0) {
      throw new ConfigError(`Test mode refuses to start while live-only secrets are set: ${live.join(', ')}`);
    }
    return;
  }
  const problems: string[] = [];
  if (config.nodeEnv !== 'production') problems.push('NODE_ENV must be production');
  if (!config.cookieSecure) problems.push('COOKIE_SECURE must be true');
  if (!config.publicOrigin.startsWith('https://')) problems.push('PUBLIC_ORIGIN must use https');
  if (!config.smtpUrl && !config.resendApiKey) problems.push('SMTP_URL or RESEND_API_KEY must be set');
  if (config.databaseSsl === 'disable') problems.push('DATABASE_SSL must not be disable');
  if (config.geoipProvider === 'test-header') problems.push('GEOIP_PROVIDER=test-header is test-only');
  if (config.seedOnStart) problems.push('SEED_ON_START must be false');
  if (config.testAutoApprove) problems.push('TEST_AUTO_APPROVE must be false');
  if (config.testSuperadminPassword) problems.push('TEST_SUPERADMIN_PASSWORD must not be set');
  if (config.paymentProvider === 'simulator') problems.push('PAYMENT_PROVIDER=simulator is test-only');
  if (problems.length > 0) throw new ConfigError(`Live mode refuses to start: ${problems.join('; ')}.`);
}
