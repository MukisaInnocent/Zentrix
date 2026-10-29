import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

// Mobile-money provider API (owner, 2026-10-30: LivePay, https://docs.livepay.me). Every call is a command and its
// answer an outcome; modules/payments/provider.ts applies outcomes to the ledger. A webhook never moves money by
// itself: it only triggers a status read, because LivePay's signature does not cover the amount.

export type ProviderName = 'livepay' | 'simulator';
export type CommandOp = 'collect' | 'payout' | 'status';

export interface ProviderCommand {
  op: CommandOp;
  provider: ProviderName;
  // Our unique reference (LivePay: no spaces, at most 30 characters).
  reference: string;
  currency: string;
  // Collect and payout only. The amount is in major units ("19000"; "5.25" for an exponent-2 currency).
  phone?: string;
  amount?: string;
  description?: string;
  // When the command was made. A collection or payout older than COMMAND_TTL_MS is never sent (a late queue retry).
  createdAt?: string;
}

// A collection or payout not sent within 5 minutes is dropped unsent: it may be a retry of one LivePay already has,
// so it is reported as 'unsure' and a status read settles it. Requests are failed for "missing" only after
// MISSING_FAIL_MINUTES (modules/payments/provider.ts), well after this window.
export const COMMAND_TTL_MS = 5 * 60_000;

export function expiredOutcome(command: ProviderCommand, now: Date): ProviderOutcome | null {
  if (command.op === 'status' || !command.createdAt) return null;
  if (now.getTime() - new Date(command.createdAt).getTime() <= COMMAND_TTL_MS) return null;
  return {
    op: command.op, provider: command.provider, reference: command.reference, at: now.toISOString(), accepted: 'unsure',
    message: 'Not sent: the command expired in the queue. Its status will be checked.',
  };
}

// A provider amount in major units, as minor units. Tolerates trailing zero decimals ("19000.00" for UGX).
export function providerAmountToMinor(value: string | undefined, exponent: number): bigint | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec((value ?? '').trim());
  if (!match) return null;
  let fraction = match[2] ?? '';
  while (fraction.length > exponent && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
  if (fraction.length > exponent) return null;
  return BigInt(match[1]!) * 10n ** BigInt(exponent) + BigInt(fraction.padEnd(exponent, '0') || '0');
}

// pending: still running; missing: the provider has no record of the reference; unknown: no usable answer.
export type OutcomeStatus = 'pending' | 'succeeded' | 'failed' | 'missing' | 'unknown';

export interface ProviderOutcome {
  op: CommandOp;
  provider: ProviderName;
  reference: string;
  at: string;
  // Collect and payout: did the provider take the request? 'unsure' (timeout, server error, duplicate reference)
  // is settled by a later status read.
  accepted?: 'yes' | 'no' | 'unsure';
  // Status reads.
  status?: OutcomeStatus;
  rawStatus?: string;
  amount?: string;
  currency?: string;
  msisdn?: string;
  providerRef?: string;
  providerTxnId?: string;
  charge?: string;
  network?: string;
  message?: string;
  httpStatus?: number;
}

export interface ProviderExecutor {
  execute(command: ProviderCommand): Promise<ProviderOutcome[]>;
}

// LivePay's status words. Only "Pending" and "Success" are documented; the rest are common spellings, and anything
// else is 'unknown', which sends the request to staff review instead of guessing (docs/PLAN.md, LivePay item 9).
export function mapStatus(raw: string): OutcomeStatus {
  const s = raw.trim().toLowerCase();
  if (['success', 'successful', 'succeeded', 'completed', 'complete', 'paid'].includes(s)) return 'succeeded';
  if (['failed', 'failure', 'fail', 'declined', 'rejected', 'cancelled', 'canceled', 'expired', 'timeout', 'timed out', 'reversed', 'error'].includes(s)) return 'failed';
  if (['pending', 'processing', 'initiated', 'in progress', 'queued', 'submitted', 'sent'].includes(s)) return 'pending';
  return 'unknown';
}

// A JSON field as text; objects and arrays (never expected here) count as missing.
export function scalar(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}
const text = (value: unknown, max = 200): string | undefined => scalar(value).slice(0, max) || undefined;

export interface LivePayOptions {
  apiKey: string;
  accountNumber: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class LivePayClient implements ProviderExecutor {
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  constructor(private readonly opts: LivePayOptions) {
    this.baseUrl = (opts.baseUrl ?? 'https://livepay.me/api').replace(/\/+$/, '');
    this.fetch = opts.fetch ?? fetch;
  }

  private async call(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.opts.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
    });
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      // Not JSON (a gateway error page): the status code says enough.
    }
    return { status: res.status, json };
  }

  async execute(command: ProviderCommand): Promise<ProviderOutcome[]> {
    const base = { op: command.op, provider: 'livepay' as const, reference: command.reference, at: new Date().toISOString() };
    try {
      if (command.op === 'status') {
        const q = new URLSearchParams({ accountNumber: this.opts.accountNumber, currency: command.currency, reference: command.reference });
        const { status, json } = await this.call('GET', `/transaction-status?${q.toString()}`);
        if (status === 404 && /transaction not found/i.test(scalar(json.error ?? json.message))) {
          return [{ ...base, status: 'missing', httpStatus: status }];
        }
        if (status !== 200 || json.success === false) {
          return [{ ...base, status: 'unknown', httpStatus: status, message: text(json.error ?? json.message) }];
        }
        const raw = text(json.status, 60) ?? '';
        return [{
          ...base, status: mapStatus(raw), rawStatus: raw, httpStatus: status, message: text(json.message),
          amount: text(json.amount, 30), currency: text(json.currency, 3), msisdn: text(json.msisdn, 20),
          providerRef: text(json.internal_reference, 100), providerTxnId: text(json.provider_transaction_id, 100),
          charge: text(json.charge, 30), network: text(json.provider, 30),
        }];
      }
      const path = command.op === 'collect' ? '/collect-money' : '/send-money';
      const { status, json } = await this.call('POST', path, {
        accountNumber: this.opts.accountNumber,
        phoneNumber: command.phone,
        amount: Number(command.amount),
        currency: command.currency,
        reference: command.reference,
        description: command.description ?? command.reference,
      });
      const message = text(json.error ?? json.message, 500);
      if (status === 200 && json.success !== false) {
        return [{ ...base, accepted: 'yes', httpStatus: status, message, providerRef: text(json.internal_reference, 100), network: text(json.network, 30) }];
      }
      // A duplicate reference means LivePay already has this request (a retry): read its status instead.
      const unsure = status >= 500 || /duplicate/i.test(message ?? '');
      return [{ ...base, accepted: unsure ? 'unsure' : 'no', httpStatus: status, message }];
    } catch (err) {
      // Timeout or network failure: the request may or may not have reached LivePay.
      const message = err instanceof Error ? err.message.slice(0, 200) : 'request failed';
      return [command.op === 'status' ? { ...base, status: 'unknown', message } : { ...base, accepted: 'unsure', message }];
    }
  }

  async balance(currency: string): Promise<{ balance: string; status: string } | null> {
    const q = new URLSearchParams({ accountNumber: this.opts.accountNumber, currency });
    const { status, json } = await this.call('GET', `/check-balance?${q.toString()}`);
    if (status !== 200 || json.success !== true) return null;
    return { balance: scalar(json.balance), status: scalar(json.status) };
  }
}

// Test mode: behaves like LivePay without any money. A collection or payout is accepted and finishes at once;
// a phone number ending in 000 fails, as if the customer declined or the number cannot receive money.
export class SimulatedProvider implements ProviderExecutor {
  execute(command: ProviderCommand): Promise<ProviderOutcome[]> {
    return Promise.resolve(this.outcomes(command));
  }

  private outcomes(command: ProviderCommand): ProviderOutcome[] {
    const base = { op: command.op, provider: 'simulator' as const, reference: command.reference, at: new Date().toISOString() };
    if (command.op === 'status') return [{ ...base, status: 'missing' }];
    const declined = (command.phone ?? '').endsWith('000');
    return [
      { ...base, accepted: 'yes', providerRef: randomUUID(), network: 'SIMULATOR' },
      {
        ...base, op: 'status', status: declined ? 'failed' : 'succeeded', rawStatus: declined ? 'Failed' : 'Success',
        message: declined ? 'Simulated: the customer declined the payment.' : 'Simulated payment completed.',
        amount: command.amount, currency: command.currency, msisdn: command.phone, providerTxnId: `SIM-${randomUUID().slice(0, 8).toUpperCase()}`, charge: '0',
      },
    ];
  }
}

// How commands reach the provider. Direct: in this process (local, Render, tests). S3 handoff (AWS): the API has
// no internet, so it leaves the command in S3 and the paygate function outside the VPC sends it; the outcome comes
// back through S3 and the `payresults` handler (server/src/lambda/paygate.ts, server/src/lambda/jobs.ts).
export interface PaymentGateway {
  readonly provider: ProviderName;
  dispatch(command: ProviderCommand): Promise<ProviderOutcome[]>;
}

export class DirectGateway implements PaymentGateway {
  constructor(readonly provider: ProviderName, private readonly executor: ProviderExecutor) {}
  dispatch(command: ProviderCommand): Promise<ProviderOutcome[]> {
    return this.executor.execute(command);
  }
}

export const PAYGATE_COMMANDS = 'paygate/commands/';
export const PAYGATE_RESULTS = 'paygate/results/';

export class S3HandoffGateway implements PaymentGateway {
  private readonly s3 = new S3Client({});
  constructor(readonly provider: ProviderName, private readonly bucket: string) {}
  async dispatch(command: ProviderCommand): Promise<ProviderOutcome[]> {
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: `${PAYGATE_COMMANDS}${command.reference}-${command.op}-${randomUUID()}.json`,
      Body: JSON.stringify(command),
      ContentType: 'application/json',
    }));
    return [];
  }
}

export interface GatewayConfig {
  paymentProvider: 'none' | 'simulator' | 'livepay';
  livepayApiKey: string | null;
  livepayAccountNumber: string | null;
  livepayBaseUrl: string;
  paygateS3Bucket: string | null;
}

export function createGateway(config: GatewayConfig): PaymentGateway | null {
  if (config.paymentProvider === 'none') return null;
  if (config.paymentProvider === 'simulator') return new DirectGateway('simulator', new SimulatedProvider());
  if (config.paygateS3Bucket) return new S3HandoffGateway('livepay', config.paygateS3Bucket);
  return new DirectGateway('livepay', new LivePayClient({
    apiKey: config.livepayApiKey ?? '', accountNumber: config.livepayAccountNumber ?? '', baseUrl: config.livepayBaseUrl,
  }));
}

// LivePay webhook signature (docs.livepay.me/webhooks): header "t=<timestamp>,v=<hex>", HMAC-SHA256 with the webhook
// secret over the webhook URL, the timestamp, then status, customer_reference and internal_reference sorted by key,
// each key followed directly by its value. LivePay documents no time window; we refuse deliveries more than five
// minutes off (its retries come 30 seconds apart).
const TOLERANCE_SECONDS = 300;
const SIGNED_FIELDS = ['customer_reference', 'internal_reference', 'status'] as const;

export function livePaySignature(secret: string, url: string, timestamp: string, payload: Record<string, unknown>): string {
  const fields = SIGNED_FIELDS.map(k => `${k}${scalar(payload[k])}`).join('');
  return createHmac('sha256', secret).update(`${url}${timestamp}${fields}`).digest('hex');
}

export function verifyLivePaySignature(secret: string, url: string, header: string, payload: Record<string, unknown>, now: Date): boolean {
  const parts = new Map(header.split(',').map(p => {
    const i = p.indexOf('=');
    return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const;
  }));
  const timestamp = parts.get('t') ?? '';
  const given = parts.get('v') ?? '';
  if (!/^\d{9,13}$/.test(timestamp) || !/^[0-9a-f]{64}$/i.test(given)) return false;
  const seconds = timestamp.length > 11 ? Number(timestamp) / 1000 : Number(timestamp);
  if (Math.abs(now.getTime() / 1000 - seconds) > TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(livePaySignature(secret, url, timestamp, payload), 'hex');
  const actual = Buffer.from(given, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
