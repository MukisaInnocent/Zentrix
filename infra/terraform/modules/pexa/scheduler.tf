# EventBridge Scheduler runs the jobs (no pg_cron). Each run wakes a paused database, so the balance check
# runs hourly in staging instead of the local worker's 5 minutes; set reconciliation_schedule to change it.
data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${local.name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

resource "aws_iam_role_policy" "scheduler" {
  name = "invoke-jobs"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "lambda:InvokeFunction", Resource = [aws_lambda_function.jobs.arn, aws_lambda_function.fxfetch.arn] }]
  })
}

locals {
  schedules = {
    reconciliation = var.reconciliation_schedule
    cleanup        = var.cleanup_schedule
    fxrates        = var.fx_rates_schedule
  }
}

resource "aws_scheduler_schedule" "jobs" {
  for_each                     = local.schedules
  name                         = "${local.name}-${each.key}"
  schedule_expression          = each.value
  schedule_expression_timezone = "UTC"
  flexible_time_window {
    mode = "OFF"
  }
  target {
    arn      = aws_lambda_function.jobs.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ job = each.key })
    retry_policy {
      maximum_retry_attempts       = 2
      maximum_event_age_in_seconds = 900
    }
  }
}

# Exchange rates: fxfetch (outside the VPC) fetches them into S3 a few minutes before the fxrates job stores them.
resource "aws_scheduler_schedule" "fxfetch" {
  name                         = "${local.name}-fxfetch"
  schedule_expression          = var.fx_fetch_schedule
  schedule_expression_timezone = "UTC"
  flexible_time_window {
    mode = "OFF"
  }
  target {
    arn      = aws_lambda_function.fxfetch.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({})
    retry_policy {
      maximum_retry_attempts       = 2
      maximum_event_age_in_seconds = 900
    }
  }
}
