# Static frontend: a private bucket that only CloudFront (Origin Access Control) can read.
resource "aws_s3_bucket" "web" {
  bucket        = "${local.name}-web-${data.aws_caller_identity.current.account_id}"
  force_destroy = var.environment != "production"
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "web" {
  bucket = aws_s3_bucket.web.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "web" {
  bucket = aws_s3_bucket.web.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.web.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "CloudFrontReadOnly"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.web.arn}/*"
      Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.main.arn } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.web]
}

# Email handoff: the API writes each outgoing message here; the mailer function sends and deletes it. Anything
# left behind (for example while email is switched off) expires after a day.
resource "aws_s3_bucket" "outbox" {
  bucket        = "${local.name}-mail-outbox-${data.aws_caller_identity.current.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "outbox" {
  bucket                  = aws_s3_bucket.outbox.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "outbox" {
  bucket = aws_s3_bucket.outbox.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "outbox" {
  bucket = aws_s3_bucket.outbox.id
  rule {
    id     = "expire-unsent-mail"
    status = "Enabled"
    filter {
      prefix = "outbox/"
    }
    expiration {
      days = 1
    }
  }
}

resource "aws_s3_bucket_policy" "outbox" {
  bucket = aws_s3_bucket.outbox.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "HttpsOnly"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.outbox.arn, "${aws_s3_bucket.outbox.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.outbox]
}

resource "aws_s3_bucket_notification" "outbox" {
  bucket = aws_s3_bucket.outbox.id
  queue {
    queue_arn     = aws_sqs_queue.mail.arn
    events        = ["s3:ObjectCreated:*"]
    filter_prefix = "outbox/"
  }
  depends_on = [aws_sqs_queue_policy.mail]
}
