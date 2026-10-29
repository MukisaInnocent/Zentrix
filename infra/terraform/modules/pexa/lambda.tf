# One package, five functions (ARM64):
#   api      Express app behind API Gateway          inside the VPC (database)
#   jobs     scheduled jobs (EventBridge Scheduler)  inside the VPC (database)
#   migrate  migrations and test seed, run by deploy inside the VPC (database)
#   mailer   sends queued email with Resend          outside the VPC (internet, no database)
#   fxfetch  fetches exchange rates into S3           outside the VPC (internet, no database)
data "archive_file" "package" {
  type        = "zip"
  source_dir  = var.lambda_package_dir
  output_path = "${path.root}/.build/pexa-lambda.zip"
}

locals {
  # The custom site domain once it is live (domain.tf), else the CloudFront link. The CloudFront link stays an
  # accepted site address while keep_temporary_links is true.
  public_origin = local.site_live ? "https://${var.site_domain}" : local.cloudfront_url
  extra_origins = local.site_live && var.keep_temporary_links ? local.cloudfront_url : ""

  # Settings shared by the functions that use the database. Secrets come from Secrets Manager at deploy time.
  db_env = {
    APP_MODE                    = var.app_mode
    NODE_ENV                    = "production"
    PUBLIC_ORIGIN               = local.public_origin
    EXTRA_ORIGINS               = local.extra_origins
    DATABASE_URL                = local.database_url
    DATABASE_SSL                = "require"
    DATABASE_POOL_MAX           = "2"
    DATABASE_CONNECT_TIMEOUT_MS = "25000"
    CSRF_SECRET                 = local.app_secret.CSRF_SECRET
    DATA_ENCRYPTION_KEY         = local.app_secret.DATA_ENCRYPTION_KEY
    TEST_AUTO_APPROVE           = tostring(var.test_auto_approve)
    TEST_SUPERADMIN_PASSWORD    = local.app_secret.TEST_SUPERADMIN_PASSWORD
    MAIL_FROM                   = var.mail_from
    RESEND_WEBHOOK_SECRET       = try(local.app_secret.RESEND_WEBHOOK_SECRET, "")
    MAIL_S3_BUCKET              = local.resend_enabled ? aws_s3_bucket.outbox.bucket : ""
    # Exchange rates: fxfetch leaves the latest snapshot in the outbox bucket under fx/.
    FX_PROVIDER  = "s3"
    FX_S3_BUCKET = aws_s3_bucket.outbox.bucket
    # Mobile money (paygate.tf): off (manual payments) until enabled; then LivePay through the S3 handoff.
    PAYMENT_PROVIDER            = var.livepay_enabled ? "livepay" : "none"
    PAYGATE_S3_BUCKET           = var.livepay_enabled ? aws_s3_bucket.outbox.bucket : ""
    LIVEPAY_LIVE_WEBHOOK_SECRET = var.livepay_enabled ? try(local.app_secret.LIVEPAY_LIVE_WEBHOOK_SECRET, "") : ""
    LIVEPAY_WEBHOOK_URL         = "${local.public_origin}/api/webhooks/livepay"
    LOG_LEVEL                   = "info"
    # Viewer -> CloudFront -> API Gateway -> Lambda.
    TRUST_PROXY = "2"
  }
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# ---- Roles ----
resource "aws_iam_role" "vpc_fn" {
  name               = "${local.name}-vpc-fn"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "vpc_fn_access" {
  role       = aws_iam_role.vpc_fn.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "vpc_fn_outbox" {
  name = "write-mail-outbox"
  role = aws_iam_role.vpc_fn.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:PutObject"], Resource = "${aws_s3_bucket.outbox.arn}/outbox/*" },
      { Effect = "Allow", Action = ["s3:GetObject"], Resource = "${aws_s3_bucket.outbox.arn}/fx/*" },
      { Effect = "Allow", Action = ["s3:PutObject"], Resource = "${aws_s3_bucket.outbox.arn}/paygate/commands/*" },
      { Effect = "Allow", Action = ["s3:GetObject", "s3:DeleteObject"], Resource = "${aws_s3_bucket.outbox.arn}/paygate/results/*" },
    ]
  })
}

resource "aws_iam_role" "mailer" {
  name               = "${local.name}-mailer"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "mailer_logs" {
  role       = aws_iam_role.mailer.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "mailer" {
  name = "read-mail-outbox"
  role = aws_iam_role.mailer.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetObject", "s3:DeleteObject"], Resource = "${aws_s3_bucket.outbox.arn}/outbox/*" },
      { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource = aws_sqs_queue.mail.arn },
    ]
  })
}

resource "aws_iam_role" "fxfetch" {
  name               = "${local.name}-fxfetch"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "fxfetch_logs" {
  role       = aws_iam_role.fxfetch.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "fxfetch" {
  name = "write-fx-rates"
  role = aws_iam_role.fxfetch.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = "${aws_s3_bucket.outbox.arn}/fx/*" },
      # Without ListBucket a missing snapshot reads as AccessDenied instead of NoSuchKey.
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.outbox.arn, Condition = { StringLike = { "s3:prefix" = ["fx/*"] } } },
    ]
  })
}

# ---- Log groups (created first so retention applies from the start) ----
resource "aws_cloudwatch_log_group" "fn" {
  for_each          = toset(["api", "jobs", "migrate", "mailer", "fxfetch"])
  name              = "/aws/lambda/${local.name}-${each.key}"
  retention_in_days = var.log_retention_days
}

# ---- Functions ----
resource "aws_lambda_function" "api" {
  function_name    = "${local.name}-api"
  role             = aws_iam_role.vpc_fn.arn
  runtime          = var.lambda_runtime
  architectures    = ["arm64"]
  handler          = "server/dist/src/lambda/api.handler"
  filename         = data.archive_file.package.output_path
  source_code_hash = data.archive_file.package.output_base64sha256
  memory_size      = var.api_memory_mb
  timeout          = 29
  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.lambda.id]
  }
  environment {
    variables = merge(local.db_env, { DATABASE_APP_ROLE = "zentrix_app" })
  }
  depends_on = [aws_cloudwatch_log_group.fn, aws_iam_role_policy_attachment.vpc_fn_access]
}

resource "aws_lambda_function" "jobs" {
  function_name    = "${local.name}-jobs"
  role             = aws_iam_role.vpc_fn.arn
  runtime          = var.lambda_runtime
  architectures    = ["arm64"]
  handler          = "server/dist/src/lambda/jobs.handler"
  filename         = data.archive_file.package.output_path
  source_code_hash = data.archive_file.package.output_base64sha256
  memory_size      = 512
  timeout          = 120
  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.lambda.id]
  }
  environment {
    variables = merge(local.db_env, { DATABASE_APP_ROLE = "zentrix_app" })
  }
  depends_on = [aws_cloudwatch_log_group.fn, aws_iam_role_policy_attachment.vpc_fn_access]
}

resource "aws_lambda_function" "migrate" {
  function_name    = "${local.name}-migrate"
  role             = aws_iam_role.vpc_fn.arn
  runtime          = var.lambda_runtime
  architectures    = ["arm64"]
  handler          = "server/dist/src/lambda/migrate.handler"
  filename         = data.archive_file.package.output_path
  source_code_hash = data.archive_file.package.output_base64sha256
  memory_size      = 512
  timeout          = 300
  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.lambda.id]
  }
  environment {
    # Runs as the database owner (no app role): migrations create tables and roles.
    variables = merge(local.db_env, {
      SEED_STAFF_PASSWORD  = local.app_secret.SEED_STAFF_PASSWORD
      SEED_MEMBER_PASSWORD = local.app_secret.SEED_MEMBER_PASSWORD
    })
  }
  depends_on = [aws_cloudwatch_log_group.fn, aws_iam_role_policy_attachment.vpc_fn_access]
}

resource "aws_lambda_function" "mailer" {
  function_name    = "${local.name}-mailer"
  role             = aws_iam_role.mailer.arn
  runtime          = var.lambda_runtime
  architectures    = ["arm64"]
  handler          = "server/dist/src/lambda/mailer.handler"
  filename         = data.archive_file.package.output_path
  source_code_hash = data.archive_file.package.output_base64sha256
  memory_size      = 256
  timeout          = 60
  environment {
    variables = {
      APP_MODE       = var.app_mode
      RESEND_API_KEY = try(local.app_secret.RESEND_API_KEY, "")
      MAIL_FROM      = var.mail_from
      LOG_LEVEL      = "info"
    }
  }
  depends_on = [aws_cloudwatch_log_group.fn, aws_iam_role_policy_attachment.mailer_logs]
}

resource "aws_lambda_event_source_mapping" "mailer" {
  event_source_arn        = aws_sqs_queue.mail.arn
  function_name           = aws_lambda_function.mailer.arn
  batch_size              = 10
  function_response_types = ["ReportBatchItemFailures"]
}

resource "aws_lambda_function" "fxfetch" {
  function_name    = "${local.name}-fxfetch"
  role             = aws_iam_role.fxfetch.arn
  runtime          = var.lambda_runtime
  architectures    = ["arm64"]
  handler          = "server/dist/src/lambda/fxfetch.handler"
  filename         = data.archive_file.package.output_path
  source_code_hash = data.archive_file.package.output_base64sha256
  memory_size      = 256
  timeout          = 30
  environment {
    variables = {
      APP_MODE     = var.app_mode
      FX_S3_BUCKET = aws_s3_bucket.outbox.bucket
      LOG_LEVEL    = "info"
    }
  }
  depends_on = [aws_cloudwatch_log_group.fn, aws_iam_role_policy_attachment.fxfetch_logs]
}
