# Outgoing email queue. S3 notifies it when the API writes a message; the mailer function consumes it. After
# five failed attempts a message moves to the dead-letter queue, which raises an alarm.
resource "aws_sqs_queue" "mail_dlq" {
  name                      = "${local.name}-mail-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "mail" {
  name                       = "${local.name}-mail"
  visibility_timeout_seconds = 180
  message_retention_seconds  = 86400
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.mail_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_policy" "mail" {
  queue_url = aws_sqs_queue.mail.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "S3OutboxNotifications"
      Effect    = "Allow"
      Principal = { Service = "s3.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.mail.arn
      Condition = {
        ArnEquals    = { "aws:SourceArn" = aws_s3_bucket.outbox.arn }
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
      }
    }]
  })
}
