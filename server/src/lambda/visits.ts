import { gunzipSync } from 'node:zlib';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createLogger } from '../lib/logger.js';
import {
  countVisits, eatDay, eatDayStart, isBot, isPageView, mergeDays, readVisitsIndex, VISITS_S3_KEY, type LogRecord, type VisitsIndex,
} from '../providers/visits.js';

// AWS Lambda entry that counts site visitors for the staff Events page (owner, 2026-11-05). Runs outside the VPC every
// hour and never touches the database. It reads the CloudFront access logs (LOGS_S3_BUCKET, under cloudfront/yyyy/MM/
// dd/HH/) from the start of yesterday in East Africa Time until now, counts yesterday and today again (late log files
// land in yesterday), and writes the merged daily counts to VISITS_S3_BUCKET. The raw logs expire after 14 days.
const logger = createLogger({ level: process.env.LOG_LEVEL ?? 'info', mode: process.env.APP_MODE === 'live' ? 'live' : 'test', service: 'pexa-visits' });
const s3 = new S3Client({});
const PREFIX = 'cloudfront/';
const HOUR_MS = 60 * 60 * 1000;

const hourPrefix = (at: Date) => `${PREFIX}${at.toISOString().slice(0, 13).replace(/[-T]/g, '/')}/`;

async function keys(bucket: string, prefix: string): Promise<string[]> {
  const found: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of page.Contents ?? []) if (o.Key) found.push(o.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return found;
}

// Keeps only the page views from one log file (JSON lines, usually gzipped).
async function pageViews(bucket: string, key: string): Promise<LogRecord[]> {
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bytes = Buffer.from(await object.Body!.transformToByteArray());
  const text = (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString('utf8');
  const kept: LogRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const r = JSON.parse(line) as LogRecord;
      if (isPageView(r) && !isBot(r)) kept.push(r);
    } catch {
      // A broken line is skipped.
    }
  }
  return kept;
}

async function storedIndex(bucket: string): Promise<VisitsIndex | null> {
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: VISITS_S3_KEY }));
    return readVisitsIndex(await object.Body!.transformToString());
  } catch (err) {
    if ((err as { name?: string }).name === 'NoSuchKey') return null;
    throw err;
  }
}

export async function handler(): Promise<{ files: number; days: { day: string; pageViews: number; visitors: number }[] }> {
  const logsBucket = process.env.LOGS_S3_BUCKET;
  const statsBucket = process.env.VISITS_S3_BUCKET;
  if (!logsBucket || !statsBucket) throw new Error('LOGS_S3_BUCKET and VISITS_S3_BUCKET must be set.');
  const now = new Date();
  const today = eatDay(now);
  const yesterday = eatDay(new Date(now.getTime() - 24 * HOUR_MS));

  const records: LogRecord[] = [];
  let files = 0;
  // One hour of slack on each side: a file's folder is the hour it was written, which can trail its requests.
  for (let at = eatDayStart(yesterday).getTime() - HOUR_MS; at <= now.getTime() + HOUR_MS; at += HOUR_MS) {
    for (const key of await keys(logsBucket, hourPrefix(new Date(at)))) {
      records.push(...(await pageViews(logsBucket, key)));
      files += 1;
    }
  }

  const fresh = countVisits(records).filter(d => d.day === yesterday || d.day === today);
  // A day with no visits still gets a row, so it shows as zero rather than missing.
  for (const day of [yesterday, today]) if (!fresh.some(d => d.day === day)) fresh.push({ day, pageViews: 0, visitors: 0, countries: {} });
  const index = mergeDays(await storedIndex(statsBucket), fresh, now);
  await s3.send(new PutObjectCommand({ Bucket: statsBucket, Key: VISITS_S3_KEY, Body: JSON.stringify(index), ContentType: 'application/json' }));
  const days = fresh.map(d => ({ day: d.day, pageViews: d.pageViews, visitors: d.visitors }));
  logger.info({ files, days }, 'visits counted');
  return { files, days };
}
