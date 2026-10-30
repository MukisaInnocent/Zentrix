# LivePay (owner, 2026-10-30; docs/PLAN.md D29). The API has no internet, so it leaves each provider command in the
# outbox bucket under paygate/commands/; S3 notifies this queue; the paygate function (outside the VPC) calls LivePay
# and writes the outcome under paygate/results/, which starts the jobs function (storage.tf) to apply it.
# Everything here exists only while livepay_enabled is true. LivePay has no sandbox: in test mode it needs the
# deliberate livepay_trial switch (owner, 2026-10-30, staging), and the keys must already be in the app secret.
locals {
  livepay = var.livepay_enabled ? 1 : 0
  livepay_keys_present = nonsensitive(alltrue([
    for k in ["LIVEPAY_LIVE_API_KEY", "LIVEPAY_LIVE_WEBHOOK_SECRET", "LIVEPAY_ACCOUNT_NUMBER"] : try(local.app_secret[k], "") != ""
  ]))
}

resource "terraform_data" "livepay_guard" {
  count = local.livepay
  lifecycle {
    precondition {
      condition     = var.app_mode == "live" || var.livepay_trial
      error_message = "LivePay moves real money. In test mode set livepay_trial = true to run a deliberate trial."
    }
    precondition {
      condition     = local.livepay_keys_present
      error_message = "Add LIVEPAY_LIVE_API_KEY, LIVEPAY_LIVE_WEBHOOK_SECRET and LIVEPAY_ACCOUNT_NUMBER to the app secret first (docs/LIVEPAY.md)."
    }
  }
}

resource "aws_sqs_queue" "paygate_dlq" {
  count                     = local.livepay
  name                      = "${local.name}-paygate-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "paygate" {
  count                      = local.livepay
  name                       = "${local.name}-paygate"
  visibility_timeout_seconds = 180
  message_retention_seconds  = 86400
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.paygate_dlq[0].arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_policy" "paygate" {
  count     = local.livepay
  queue_url = aws_sqs_queue.paygate[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "S3PaygateNotifications"
      Effect    = "Allow"
      Principal = { Service = "s3.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.paygate[0].arn
      Condition = {
        ArnEquals    = { "aws:SourceArn" = aws_s3_bucket.outbox.arn }
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
      }
    }]
  })
}

resource "aws_iam_role" "paygate" {
  count              = local.livepay
  name               = "${local.name}-paygate"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "paygate_logs" {
  count      = local.livepay
  role       = aws_iam_role.paygate[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "paygate" {
  count = local.livepay
  name  = "paygate-handoff"
  role  = aws_iam_role.paygate[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetObject", "s3:DeleteObject"], Resource = "${aws_s3_bucket.outbox.arn}/paygate/commands/*" },
      { Effect = "Allow", Action = ["s3:PutObject"], Resource = "${aws_s3_bucket.outbox.arn}/paygate/results/*" },
      { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource = aws_sqs_queue.paygate[0].arn },
    ]
  })
}

resource "aws_cloudwatch_log_group" "paygate" {
  count             = local.livepay
  name              = "/aws/lambda/${local.name}-paygate"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "paygate" {
  count            = local.livepay
  function_name    = "${local.name}-paygate"
  role             = aws_iam_role.paygate[0].arn
  runtime          = var.lambda_runtime
  architectures    = ["arm64"]
  handler          = "server/dist/src/lambda/paygate.handler"
  filename         = data.archive_file.package.output_path
  source_code_hash = data.archive_file.package.output_base64sha256
  memory_size      = 256
  timeout          = 60
  environment {
    variables = {
      APP_MODE               = var.app_mode
      LIVEPAY_LIVE_API_KEY   = try(local.app_secret.LIVEPAY_LIVE_API_KEY, "")
      LIVEPAY_ACCOUNT_NUMBER = try(local.app_secret.LIVEPAY_ACCOUNT_NUMBER, "")
      LOG_LEVEL              = "info"
    }
  }
  depends_on = [aws_cloudwatch_log_group.paygate, aws_iam_role_policy_attachment.paygate_logs, terraform_data.livepay_guard]
}

resource "aws_lambda_event_source_mapping" "paygate" {
  count                   = local.livepay
  event_source_arn        = aws_sqs_queue.paygate[0].arn
  function_name           = aws_lambda_function.paygate[0].arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
  # At most two commands at once (the lowest SQS allows) keeps LivePay's 5 payouts a minute easy to respect. Not
  # reserved concurrency: this account's limit is 10, and AWS refuses to reserve any of it.
  scaling_config {
    maximum_concurrency = 2
  }
}

resource "aws_cloudwatch_metric_alarm" "paygate_dlq" {
  count               = local.livepay
  alarm_name          = "${local.name}-paygate-dlq"
  alarm_description   = "Pexa ${var.environment}: a LivePay command failed five times. Check the paygate logs and the LivePay dashboard."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.paygate_dlq[0].name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
}
