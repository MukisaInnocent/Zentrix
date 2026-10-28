import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createLogger } from '../lib/logger.js';
import { FX_S3_KEY, OpenErApiSource, readSnapshot, type FxSnapshot } from '../providers/fx.js';

// AWS Lambda entry that fetches exchange rates. Runs outside the VPC (it needs the internet, not the database) every
// 5 minutes. It asks the provider only once the stored snapshot's announced next update has passed, and writes S3
// only when the rates are new; that write starts the `fxrates` job (S3 notification), so the database wakes only for
// new rates (owner, 2026-10-28).
const logger = createLogger({ level: process.env.LOG_LEVEL ?? 'info', mode: process.env.APP_MODE === 'live' ? 'live' : 'test', service: 'pexa-fxfetch' });
const s3 = new S3Client({});
const source = new OpenErApiSource();

async function stored(bucket: string): Promise<FxSnapshot | null> {
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: FX_S3_KEY }));
    return readSnapshot(await object.Body!.transformToString());
  } catch (err) {
    if ((err as { name?: string }).name === 'NoSuchKey') return null;
    throw err;
  }
}

export async function handler(): Promise<{ rateAt: string; currencies: number; written: boolean }> {
  const bucket = process.env.FX_S3_BUCKET;
  if (!bucket) throw new Error('FX_S3_BUCKET is not set.');
  const previous = await stored(bucket);
  const currencies = (s: FxSnapshot) => Object.keys(s.unitsPerUsd).length;
  if (previous?.nextUpdateAt && previous.nextUpdateAt > new Date()) {
    return { rateAt: previous.rateAt.toISOString(), currencies: currencies(previous), written: false };
  }
  const snapshot = await source.latest();
  const written = previous?.rateAt.getTime() !== snapshot.rateAt.getTime();
  if (written) {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: FX_S3_KEY, Body: JSON.stringify(snapshot), ContentType: 'application/json' }));
    logger.info({ source: snapshot.source, rateAt: snapshot.rateAt, currencies: currencies(snapshot) }, 'new exchange rates fetched');
  }
  return { rateAt: snapshot.rateAt.toISOString(), currencies: currencies(snapshot), written };
}
