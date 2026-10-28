import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createLogger } from '../lib/logger.js';
import { FX_S3_KEY, OpenErApiSource } from '../providers/fx.js';

// AWS Lambda entry that fetches exchange rates. Runs outside the VPC (it needs the internet, not the database) on a
// schedule, and leaves the snapshot in S3; the jobs function (inside the VPC) stores it with the `fxrates` job.
const logger = createLogger({ level: process.env.LOG_LEVEL ?? 'info', mode: process.env.APP_MODE === 'live' ? 'live' : 'test', service: 'pexa-fxfetch' });
const s3 = new S3Client({});
const source = new OpenErApiSource();

export async function handler(): Promise<{ rateAt: string; currencies: number }> {
  const bucket = process.env.FX_S3_BUCKET;
  if (!bucket) throw new Error('FX_S3_BUCKET is not set.');
  const snapshot = await source.latest();
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: FX_S3_KEY, Body: JSON.stringify(snapshot), ContentType: 'application/json' }));
  const currencies = Object.keys(snapshot.unitsPerUsd).length;
  logger.info({ source: snapshot.source, rateAt: snapshot.rateAt, currencies }, 'exchange rates fetched');
  return { rateAt: snapshot.rateAt.toISOString(), currencies };
}
