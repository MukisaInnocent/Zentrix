import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createLogger } from '../lib/logger.js';
import { isReservedAddress, ResendMailer, type MailMessage } from '../providers/mail.js';

// AWS Lambda entry for outgoing email. Runs outside the VPC (it needs the internet, not the database). The API
// writes each message to the outbox bucket (S3HandoffMailer); S3 notifies the SQS queue, which triggers this
// function. Each message is sent with Resend and its object deleted. A failed message is retried, then moves to
// the dead-letter queue, which raises an alarm. Message bodies are never logged.
interface SqsEvent { Records: { messageId: string; body: string }[] }
interface S3Notification { Records?: { s3: { bucket: { name: string }; object: { key: string } } }[]; Event?: string }

const logger = createLogger({ level: process.env.LOG_LEVEL ?? 'info', mode: process.env.APP_MODE === 'live' ? 'live' : 'test', service: 'pexa-mailer' });
const s3 = new S3Client({});
const apiKey = process.env.RESEND_API_KEY ?? '';
const mailer = apiKey ? new ResendMailer(apiKey, process.env.MAIL_FROM ?? 'Pexerearn <info@pexerearn.com>') : null;
// Resend allows a few requests a second per account. With at most 2 mailers running (the queue's maximum
// concurrency) and each send taking at least this long, a large announcement stays within the limit and members'
// own emails are not refused alongside it (owner, 2026-11-11).
const SEND_INTERVAL_MS = Number(process.env.MAIL_SEND_INTERVAL_MS ?? 1000);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function handler(event: SqsEvent): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      const note = JSON.parse(record.body) as S3Notification;
      if (note.Event === 's3:TestEvent') continue;
      for (const r of note.Records ?? []) {
        const bucket = r.s3.bucket.name;
        const key = decodeURIComponent(r.s3.object.key.replace(/\+/g, ' '));
        const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const message = JSON.parse(await object.Body!.transformToString()) as MailMessage;
        if (!mailer) throw new Error('RESEND_API_KEY is not set; email cannot be delivered.');
        const reserved = isReservedAddress(message.to);
        if (!reserved) {
          const started = Date.now();
          await mailer.send(message);
          await pause(Math.max(0, SEND_INTERVAL_MS - (Date.now() - started)));
        }
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        logger.info({ key }, reserved ? 'email skipped: test address that cannot receive mail' : 'email sent');
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err), messageId: record.messageId }, 'email not sent; will retry');
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
