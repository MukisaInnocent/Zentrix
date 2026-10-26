import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createLogger } from '../lib/logger.js';
import { ResendMailer, type MailMessage } from '../providers/mail.js';

// AWS Lambda entry for outgoing email. Runs outside the VPC (it needs the internet, not the database). The API
// writes each message to the outbox bucket (S3HandoffMailer); S3 notifies the SQS queue, which triggers this
// function. Each message is sent with Resend and its object deleted. A failed message is retried, then moves to
// the dead-letter queue, which raises an alarm. Message bodies are never logged.
interface SqsEvent { Records: { messageId: string; body: string }[] }
interface S3Notification { Records?: { s3: { bucket: { name: string }; object: { key: string } } }[]; Event?: string }

const logger = createLogger({ level: process.env.LOG_LEVEL ?? 'info', mode: process.env.APP_MODE === 'live' ? 'live' : 'test', service: 'pexa-mailer' });
const s3 = new S3Client({});
const apiKey = process.env.RESEND_API_KEY ?? '';
const mailer = apiKey ? new ResendMailer(apiKey, process.env.MAIL_FROM ?? 'Pexa <onboarding@resend.dev>') : null;

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
        await mailer.send(message);
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        logger.info({ key }, 'email sent');
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err), messageId: record.messageId }, 'email not sent; will retry');
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
