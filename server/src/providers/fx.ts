import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';
import type { Config } from '../config/env.js';

// Exchange rates (section 5: FX source interface). A snapshot gives each currency's units per US dollar as a
// decimal string, never a float in our own arithmetic. The default source is the free ExchangeRate-API open
// endpoint (no key, refreshed daily by the provider).

export interface FxSnapshot {
  source: string;
  rateAt: Date;
  /** When the provider publishes its next rates; asking again before then returns the same numbers. */
  nextUpdateAt?: Date;
  unitsPerUsd: Record<string, string>;
}

export interface FxSource {
  latest(): Promise<FxSnapshot>;
}

export const OPEN_ER_API_URL = 'https://open.er-api.com/v6/latest/USD';
// Where the AWS fetcher (server/src/lambda/fxfetch.ts) leaves the latest snapshot for the jobs function.
export const FX_S3_KEY = 'fx/latest.json';

const OpenErApiResponse = z.object({
  result: z.literal('success'),
  base_code: z.literal('USD'),
  time_last_update_unix: z.number().int().positive(),
  time_next_update_unix: z.number().int().positive().optional(),
  rates: z.record(z.string().regex(/^[A-Z]{3}$/), z.number().positive().finite()),
});

const Snapshot = z.object({
  source: z.string().min(1).max(60),
  rateAt: z.coerce.date(),
  nextUpdateAt: z.coerce.date().optional(),
  unitsPerUsd: z.record(z.string().regex(/^[A-Z]{3}$/), z.string().regex(/^\d{1,18}(\.\d{1,12})?$/)),
});

// The provider publishes new rates once a day and blocks an address that asks too often (HTTP 429 for 20
// minutes), so the source keeps its last answer until the provider's announced next update.
export class OpenErApiSource implements FxSource {
  private cached: FxSnapshot | null = null;
  constructor(private readonly url = OPEN_ER_API_URL, private readonly now = () => new Date()) {}
  async latest(): Promise<FxSnapshot> {
    if (this.cached?.nextUpdateAt && this.cached.nextUpdateAt > this.now()) return this.cached;
    const res = await fetch(this.url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Exchange-rate API answered HTTP ${res.status}`);
    const body = OpenErApiResponse.parse(await res.json());
    const unitsPerUsd: Record<string, string> = {};
    for (const [code, rate] of Object.entries(body.rates)) {
      const text = rate.toFixed(12).replace(/\.?0+$/, '');
      if (/^\d{1,18}(\.\d{1,12})?$/.test(text) && text !== '0') unitsPerUsd[code] = text;
    }
    this.cached = {
      source: 'open.er-api.com',
      rateAt: new Date(body.time_last_update_unix * 1000),
      ...(body.time_next_update_unix ? { nextUpdateAt: new Date(body.time_next_update_unix * 1000) } : {}),
      unitsPerUsd,
    };
    return this.cached;
  }
}

// AWS: the jobs function has no internet access, so it reads the snapshot the fetcher wrote to S3.
export class S3FxSource implements FxSource {
  private readonly s3 = new S3Client({});
  constructor(private readonly bucket: string) {}
  async latest(): Promise<FxSnapshot> {
    const object = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: FX_S3_KEY }));
    return readSnapshot(await object.Body!.transformToString());
  }
}

export const readSnapshot = (json: string): FxSnapshot => Snapshot.parse(JSON.parse(json));

// Tests and offline work: a fixed snapshot.
export class FixedFxSource implements FxSource {
  constructor(private readonly snapshot: FxSnapshot) {}
  latest(): Promise<FxSnapshot> {
    return Promise.resolve(this.snapshot);
  }
}

export function createFxSource(config: Config): FxSource | null {
  if (config.fxProvider === 's3') return config.fxS3Bucket ? new S3FxSource(config.fxS3Bucket) : null;
  if (config.fxProvider === 'open-er-api') return new OpenErApiSource();
  return null;
}
