import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';
import type { Config } from '../config/env.js';
import { LivePayClient } from './livepay.js';

// LivePay's real account balance, for the staff Overall balance page (owner, 2026-11-10). On AWS the API has no
// internet, so the paygate function (outside the VPC) reads it every 15 minutes and leaves it in S3 under
// PAYGATE_BALANCE_KEY; the page reads that file and the database is never woken for it. Run directly (local,
// Render) it is read from LivePay on request. Balances are LivePay's own text, in major units ("1250000").

export const PAYGATE_BALANCE_KEY = 'paygate/balance/latest.json';
// The currencies read: Uganda, and Ghana since 2026-11-11 (docs/LIVEPAY.md).
export const PROVIDER_BALANCE_CURRENCIES = ['UGX', 'GHS'] as const;

const SnapshotSchema = z.object({
  readAt: z.string(),
  balances: z.array(z.object({ currency: z.string().length(3), balance: z.string().max(40) })).max(20),
});
export type ProviderBalanceSnapshot = z.infer<typeof SnapshotSchema>;
export const readSnapshot = (json: string): ProviderBalanceSnapshot => SnapshotSchema.parse(JSON.parse(json));

export interface ProviderBalanceSource {
  latest(): Promise<ProviderBalanceSnapshot | null>;
}

// Reads every currency's balance from LivePay; a currency LivePay does not answer is left out.
export async function readLivePayBalances(client: Pick<LivePayClient, 'balance'>, now: Date): Promise<ProviderBalanceSnapshot> {
  const balances: ProviderBalanceSnapshot['balances'] = [];
  for (const currency of PROVIDER_BALANCE_CURRENCIES) {
    const b = await client.balance(currency);
    if (b && /^\d+(\.\d+)?$/.test(b.balance.trim())) balances.push({ currency, balance: b.balance.trim() });
  }
  return { readAt: now.toISOString(), balances };
}

export class S3ProviderBalance implements ProviderBalanceSource {
  private readonly s3 = new S3Client({});
  constructor(private readonly bucket: string) {}
  async latest(): Promise<ProviderBalanceSnapshot | null> {
    try {
      const object = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: PAYGATE_BALANCE_KEY }));
      return readSnapshot(await object.Body!.transformToString());
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') return null;
      throw err;
    }
  }
}

export class DirectProviderBalance implements ProviderBalanceSource {
  constructor(private readonly client: LivePayClient) {}
  latest(): Promise<ProviderBalanceSnapshot | null> {
    return readLivePayBalances(this.client, new Date());
  }
}

// Tests: a fixed snapshot.
export class FixedProviderBalance implements ProviderBalanceSource {
  constructor(private readonly value: ProviderBalanceSnapshot | null) {}
  latest(): Promise<ProviderBalanceSnapshot | null> {
    return Promise.resolve(this.value);
  }
}

// Only where LivePay itself is used: the simulator has no balance.
export function createProviderBalance(config: Pick<Config, 'paymentProvider' | 'paygateS3Bucket' | 'livepayApiKey' | 'livepayAccountNumber' | 'livepayBaseUrl'>): ProviderBalanceSource | null {
  if (config.paymentProvider !== 'livepay') return null;
  if (config.paygateS3Bucket) return new S3ProviderBalance(config.paygateS3Bucket);
  if (!config.livepayApiKey || !config.livepayAccountNumber) return null;
  return new DirectProviderBalance(new LivePayClient({ apiKey: config.livepayApiKey, accountNumber: config.livepayAccountNumber, baseUrl: config.livepayBaseUrl }));
}
