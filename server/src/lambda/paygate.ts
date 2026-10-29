import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createLogger } from '../lib/logger.js';
import { LivePayClient, PAYGATE_COMMANDS, PAYGATE_RESULTS, type ProviderCommand } from '../providers/livepay.js';

// AWS Lambda entry that talks to LivePay. Runs outside the VPC (it needs the internet, not the database), like the
// mailer. The API writes each command to the bucket under paygate/commands/ (S3HandoffGateway); S3 notifies the SQS
// queue, which triggers this function. It calls LivePay, writes the outcomes under paygate/results/ (which starts the
// `payresults` handler in the jobs function, inside the VPC) and deletes the command. A failed command is retried,
// then moves to the dead-letter queue; a retried collection or payout is safe because LivePay refuses a duplicate
// reference and the status read settles it. Phone numbers and amounts are never logged.
interface SqsEvent { Records: { messageId: string; body: string }[] }
interface S3Notification { Records?: { s3: { bucket: { name: string }; object: { key: string } } }[]; Event?: string }

const logger = createLogger({ level: process.env.LOG_LEVEL ?? 'info', mode: process.env.APP_MODE === 'live' ? 'live' : 'test', service: 'pexa-paygate' });
const s3 = new S3Client({});
const apiKey = process.env.LIVEPAY_LIVE_API_KEY ?? '';
const accountNumber = process.env.LIVEPAY_ACCOUNT_NUMBER ?? '';
const client = apiKey && accountNumber
  ? new LivePayClient({ apiKey, accountNumber, ...(process.env.LIVEPAY_BASE_URL ? { baseUrl: process.env.LIVEPAY_BASE_URL } : {}) })
  : null;

export async function handler(event: SqsEvent): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> {
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
        const outcomes = await client.execute(command);
        await s3.send(new PutObjectCommand({
          Bucket: bucket, Key: `${PAYGATE_RESULTS}${command.reference}-${command.op}-${randomUUID()}.json`,
          Body: JSON.stringify(outcomes), ContentType: 'application/json',
        }));
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
