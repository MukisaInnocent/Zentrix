# Site visitors for the staff Events page (owner, 2026-11-05). CloudFront writes its access logs (standard logging
# v2, JSON, only the fields below, including the visitor's country) to a private bucket; the visits function, outside
# the VPC and without the database, counts them every hour into stats/visits/index.json in the outbox bucket, which
# the API reads through the S3 gateway endpoint. The raw logs hold IP addresses, so they expire after
# access_log_retention_days. Log delivery itself is free; S3 storage and requests cost a few cents a month.

resource "aws_s3_bucket" "access_logs" {
  bucket        = "${local.name}-access-logs-${data.aws_caller_identity.current.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "access_logs" {
  bucket                  = aws_s3_bucket.access_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  rule {
    id     = "expire-access-logs"
    status = "Enabled"
    filter {
      prefix = "cloudfront/"
    }
    expiration {
      days = var.access_log_retention_days
    }
  }
}

# CloudWatch Logs delivers CloudFront logs from us-east-1 (where CloudFront's log sources live) into this bucket.
resource "aws_s3_bucket_policy" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AWSLogDeliveryWrite"
        Effect    = "Allow"
        Principal = { Service = "delivery.logs.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.access_logs.arn}/cloudfront/*"
        Condition = {
          StringEquals = { "s3:x-amz-acl" = "bucket-owner-full-control", "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
          ArnLike      = { "aws:SourceArn" = "arn:aws:logs:us-east-1:${data.aws_caller_identity.current.account_id}:delivery-source:*" }
        }
      },
      {
        Sid       = "AWSLogDeliveryAclCheck"
        Effect    = "Allow"
        Principal = { Service = "delivery.logs.amazonaws.com" }
        Action    = ["s3:GetBucketAcl", "s3:ListBucket"]
        Resource  = aws_s3_bucket.access_logs.arn
        Condition = {
          StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
          ArnLike      = { "aws:SourceArn" = "arn:aws:logs:us-east-1:${data.aws_caller_identity.current.account_id}:delivery-source:*" }
        }
      },
      {
        Sid       = "HttpsOnly"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.access_logs.arn, "${aws_s3_bucket.access_logs.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
    ]
  })
  depends_on = [aws_s3_bucket_public_access_block.access_logs]
}

resource "aws_cloudwatch_log_delivery_source" "cloudfront" {
  provider     = aws.us_east_1
  name         = "${local.name}-cloudfront-access"
  log_type     = "ACCESS_LOGS"
  resource_arn = aws_cloudfront_distribution.main.arn
}

# With a prefix in the destination ARN, CloudFront writes under that prefix instead of AWSLogs/<account>/CloudFront/.
resource "aws_cloudwatch_log_delivery_destination" "access_logs" {
  provider      = aws.us_east_1
  name          = "${local.name}-access-logs"
  output_format = "json"
  delivery_destination_configuration {
    destination_resource_arn = "${aws_s3_bucket.access_logs.arn}/cloudfront"
  }
}

resource "aws_cloudwatch_log_delivery" "cloudfront" {
  provider                 = aws.us_east_1
  delivery_source_name     = aws_cloudwatch_log_delivery_source.cloudfront.name
  delivery_destination_arn = aws_cloudwatch_log_delivery_destination.access_logs.arn
  # Only what the visit count needs (server/src/providers/visits.ts).
  record_fields = ["date", "time", "c-ip", "cs-method", "cs-uri-stem", "sc-status", "cs(User-Agent)", "sc-content-type", "c-country"]
  s3_delivery_configuration {
    suffix_path                 = "{yyyy}/{MM}/{dd}/{HH}"
    enable_hive_compatible_path = false
  }
  depends_on = [aws_s3_bucket_policy.access_logs]
}

resource "aws_iam_role" "visits" {
  name               = "${local.name}-visits"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "visits_logs" {
  role       = aws_iam_role.visits.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "visits" {
  name = "count-visits"
  role = aws_iam_role.visits.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.access_logs.arn, Condition = { StringLike = { "s3:prefix" = ["cloudfront/*"] } } },
      { Effect = "Allow", Action = ["s3:GetObject"], Resource = "${aws_s3_bucket.access_logs.arn}/cloudfront/*" },
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = "${aws_s3_bucket.outbox.arn}/stats/visits/*" },
      # Without ListBucket a missing summary reads as AccessDenied instead of NoSuchKey.
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.outbox.arn, Condition = { StringLike = { "s3:prefix" = ["stats/visits/*"] } } },
    ]
  })
}

resource "aws_lambda_function" "visits" {
  function_name    = "${local.name}-visits"
  role             = aws_iam_role.visits.arn
  runtime          = var.lambda_runtime
  architectures    = ["arm64"]
  handler          = "server/dist/src/lambda/visits.handler"
  filename         = data.archive_file.package.output_path
  source_code_hash = data.archive_file.package.output_base64sha256
  memory_size      = 512
  timeout          = 300
  environment {
    variables = {
      APP_MODE         = var.app_mode
      LOGS_S3_BUCKET   = aws_s3_bucket.access_logs.bucket
      VISITS_S3_BUCKET = aws_s3_bucket.outbox.bucket
      LOG_LEVEL        = "info"
    }
  }
  depends_on = [aws_cloudwatch_log_group.fn, aws_iam_role_policy_attachment.visits_logs]
}

resource "aws_scheduler_schedule" "visits" {
  name                         = "${local.name}-visits"
  schedule_expression          = var.visits_schedule
  schedule_expression_timezone = "UTC"
  flexible_time_window {
    mode = "OFF"
  }
  target {
    arn      = aws_lambda_function.visits.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({})
    retry_policy {
      maximum_retry_attempts       = 1
      maximum_event_age_in_seconds = 900
    }
  }
}
