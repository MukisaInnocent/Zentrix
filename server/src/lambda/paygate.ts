import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createLogger } from '../lib/logger.js';
import { expiredOutcome, LivePayClient, PAYGATE_COMMANDS, PAYGATE_RESULTS, type ProviderCommand, type ProviderOutcome } from '../providers/livepay.js';
import { decideWatch, PAYGATE_WATCH, WATCH_READS_PER_RUN, type WatchMarker } from '../providers/paywatch.js';

// AWS Lambda entry that talks to LivePay. Runs outside the VPC (it needs the internet, not the database), like the
// mailer. The API writes each command to the bucket under paygate/commands/ (S3HandoffGateway); S3 notifies the SQS
// queue, which triggers this function. It calls LivePay, writes the outcomes under paygate/results/ (which starts the
// `payresults` handler in the jobs function, inside the VPC) and deletes the command. A failed command is retried,
// then moves to the dead-letter queue; a retried collection or payout is safe because LivePay refuses a duplicate
// reference and the status read settles it; a command older than 5 minutes is not sent at all. Phone numbers and
// amounts are never logged.
//
// EventBridge Scheduler also runs it every minute with { "watch": true }: it reads the status of the requests marked
// under paygate/watch/ and hands an outcome to the database only when it can change something (providers/paywatch.ts),
// so the database sleeps while nothing is open or nothing has changed.
interface SqsEvent { Records: { messageId: string; body: string }[] }
interface WatchEvent { watch: true }
interface S3Notification { Records?: { s3: { bucket: { name: string }; object: { key: string } } }[]; Event?: string }

const logger = createLogger({ level: process.env.LOG_LEVEL ?? 'info', mode: process.env.APP_MODE === 'live' ? 'live' : 'test', service: 'pexa-paygate' });
const s3 = new S3Client({});
const apiKey = process.env.LIVEPAY_LIVE_API_KEY ?? '';
const accountNumber = process.env.LIVEPAY_ACCOUNT_NUMBER ?? '';
const client = apiKey && accountNumber
  ? new LivePayClient({ apiKey, accountNumber, ...(process.env.LIVEPAY_BASE_URL ? { baseUrl: process.env.LIVEPAY_BASE_URL } : {}) })
  : null;

async function putResult(bucket: string, reference: string, op: string, outcomes: ProviderOutcome[]): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: `${PAYGATE_RESULTS}${reference}-${op}-${randomUUID()}.json`,
    Body: JSON.stringify(outcomes), ContentType: 'application/json',
  }));
}

async function watch(): Promise<{ checked: number; forwarded: number }> {
  const bucket = process.env.PAYGATE_S3_BUCKET ?? '';
  if (!client || !bucket) throw new Error('PAYGATE_S3_BUCKET, LIVEPAY_LIVE_API_KEY or LIVEPAY_ACCOUNT_NUMBER is not set.');
  const now = new Date();
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: PAYGATE_WATCH, MaxKeys: 1000 }));
  const markers: { key: string; marker: WatchMarker }[] = [];
  for (const o of listed.Contents ?? []) {
    if (!o.Key) continue;
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: o.Key }));
    const marker = JSON.parse(await object.Body!.transformToString()) as WatchMarker;
    if (new Date(marker.nextCheckAt) <= now) markers.push({ key: o.Key, marker });
  }
  markers.sort((a, b) => a.marker.nextCheckAt.localeCompare(b.marker.nextCheckAt));
  let checked = 0;
  let forwarded = 0;
  for (const { key, marker } of markers.slice(0, WATCH_READS_PER_RUN)) {
    try {
      const outcomes = await client.execute({ op: 'status', provider: marker.provider, reference: marker.reference, currency: marker.currency });
      checked++;
      const decision = decideWatch(marker, outcomes[0], new Date());
      if (decision.forward) {
        await putResult(bucket, marker.reference, 'status', outcomes);
        forwarded++;
      }
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(decision.marker), ContentType: 'application/json' }));
      logger.info({ reference: marker.reference, status: outcomes[0]?.status, forwarded: decision.forward }, 'watched request read');
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err), reference: marker.reference }, 'watched request not read; next run tries again');
    }
  }
  return { checked, forwarded };
}

export async function handler(event: SqsEvent | WatchEvent): Promise<{ batchItemFailures: { itemIdentifier: string }[] } | { checked: number; forwarded: number }> {
  if ('watch' in event) return watch();
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      const note = JSON.parse(record.body) as S3Notification;
      if (note.Event === 's3:TestEvent') continue;
      for (const r of note.Records ?? []) {
        const bucket = r.s3.bucket.name;
        const key = decodeURIComponent(r.s3.object.key.replace(/\+/g, ' '));
        if (!key.startsWith(PAYGATE_COMMANDS)) continue;
        if (!client) throw new Error('LIVEPAY_LIVE_API_KEY or LIVEPAY_ACCOUNT_NUMBER is not set; the command waits.');
        const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const command = JSON.parse(await object.Body!.transformToString()) as ProviderCommand;
        // A stale collection or payout (late retry, or a dead-letter redrive) is never sent.
        const expired = expiredOutcome(command, new Date());
        const outcomes = expired ? [expired] : await client.execute(command);
        await putResult(bucket, command.reference, command.op, outcomes);
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        logger.info({ reference: command.reference, op: command.op, accepted: outcomes[0]?.accepted, status: outcomes[0]?.status }, 'provider command sent');
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err), messageId: record.messageId }, 'provider command not sent; will retry');
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
