# Pexa account-wide resources, applied once by hand (docs/DEPLOYMENT.md), before the first pipeline run:
#   GitHub OpenID Connect and the deploy roles (no stored AWS keys), CloudTrail, GuardDuty, the monthly budget.
terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
  backend "s3" {
    bucket       = "pexerearn-tfstate-48213"
    key          = "pexa/global/terraform.tfstate"
    region       = "eu-west-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = "eu-west-1"
  default_tags {
    tags = { Project = "Pexa", Environment = "global", ManagedBy = "Terraform", Repository = var.github_repository }
  }
}

variable "github_repository" {
  description = "owner/name of the GitHub repository allowed to deploy."
  type        = string
  default     = "MukisaInnocent/Zentrix"
}

variable "github_repository_with_ids" {
  description = "The same repository as GitHub names it in OpenID Connect tokens: owner@ownerId/name@repoId."
  type        = string
  default     = "MukisaInnocent@174857358/Zentrix@1424697357"
}

variable "state_bucket" {
  type    = string
  default = "pexerearn-tfstate-48213"
}

variable "budget_email" {
  description = "Where budget alerts go."
  type        = string
}

variable "monthly_budget_usd" {
  description = "Monthly spend that triggers alerts (at 80% forecast and 100% actual)."
  type        = number
  default     = 30
}

data "aws_caller_identity" "current" {}

# ---- GitHub OpenID Connect ----
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

# One role per GitHub environment. A workflow job can assume it only when it runs in that environment of this
# repository, so the production role is reachable only after the production environment's approval rule.
locals {
  deploy_environments = ["staging", "production"]
}

data "aws_iam_policy_document" "github_trust" {
  for_each = toset(local.deploy_environments)
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      # GitHub now sends the owner and repository with their numeric IDs (the second form); the first is the
      # older form. Both name exactly this repository and environment.
      values = [
        "repo:${var.github_repository}:environment:${each.key}",
        "repo:${var.github_repository_with_ids}:environment:${each.key}",
      ]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  for_each             = toset(local.deploy_environments)
  name                 = "pexa-github-deploy-${each.key}"
  description          = "Assumed by GitHub Actions (${var.github_repository}, environment ${each.key}) to run Terraform."
  assume_role_policy   = data.aws_iam_policy_document.github_trust[each.key].json
  max_session_duration = 3600
}

# Terraform creates networks, databases, functions and IAM roles, so the deploy role needs wide rights. It is
# limited to this repository and environment by the trust policy, and denied the actions a deploy never needs:
# IAM users and access keys, account and organization changes, and the account-wide security services.
resource "aws_iam_role_policy_attachment" "github_deploy_admin" {
  for_each   = aws_iam_role.github_deploy
  role       = each.value.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

resource "aws_iam_role_policy" "github_deploy_guardrails" {
  for_each = aws_iam_role.github_deploy
  name     = "pexa-deploy-guardrails"
  role     = each.value.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "NoLongLivedCredentials"
        Effect   = "Deny"
        Action   = ["iam:CreateUser", "iam:CreateAccessKey", "iam:CreateLoginProfile", "iam:UpdateLoginProfile", "iam:AttachUserPolicy", "iam:PutUserPolicy"]
        Resource = "*"
      },
      {
        Sid      = "NoAccountChanges"
        Effect   = "Deny"
        Action   = ["organizations:*", "account:*", "iam:DeleteOpenIDConnectProvider", "iam:UpdateOpenIDConnectProviderThumbprint"]
        Resource = "*"
      },
      {
        Sid      = "KeepAuditAndThreatDetection"
        Effect   = "Deny"
        Action   = ["cloudtrail:DeleteTrail", "cloudtrail:StopLogging", "cloudtrail:UpdateTrail", "guardduty:DeleteDetector", "guardduty:UpdateDetector"]
        Resource = "*"
      },
      {
        Sid       = "NoOtherRegions"
        Effect    = "Deny"
        NotAction = ["iam:*", "sts:*", "cloudfront:*", "budgets:*", "route53:*", "acm:*", "wafv2:*", "support:*", "health:*"]
        Resource  = "*"
        Condition = { StringNotEquals = { "aws:RequestedRegion" = "eu-west-1" } }
      },
      {
        # Each role writes only its own environment's state; the global stack is applied by hand.
        Sid    = "OnlyItsOwnState"
        Effect = "Deny"
        Action = ["s3:PutObject", "s3:DeleteObject"]
        Resource = concat(
          ["arn:aws:s3:::${var.state_bucket}/pexa/global/*"],
          [for env in local.deploy_environments : "arn:aws:s3:::${var.state_bucket}/pexa/${env}/*" if env != each.key],
        )
      },
    ]
  })
}

# ---- CloudTrail: one trail of management events (the first copy is free; only S3 storage is paid) ----
resource "aws_s3_bucket" "trail" {
  bucket = "pexa-cloudtrail-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "trail" {
  bucket                  = aws_s3_bucket.trail.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "trail" {
  bucket = aws_s3_bucket.trail.id
  rule {
    id     = "expire-after-a-year"
    status = "Enabled"
    filter {}
    expiration {
      days = 365
    }
  }
}

resource "aws_s3_bucket_policy" "trail" {
  bucket = aws_s3_bucket.trail.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "CloudTrailAclCheck"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:GetBucketAcl"
        Resource  = aws_s3_bucket.trail.arn
        Condition = { StringEquals = { "aws:SourceArn" = "arn:aws:cloudtrail:eu-west-1:${data.aws_caller_identity.current.account_id}:trail/pexa" } }
      },
      {
        Sid       = "CloudTrailWrite"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.trail.arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"
        Condition = {
          StringEquals = {
            "s3:x-amz-acl"  = "bucket-owner-full-control"
            "aws:SourceArn" = "arn:aws:cloudtrail:eu-west-1:${data.aws_caller_identity.current.account_id}:trail/pexa"
          }
        }
      },
    ]
  })
  depends_on = [aws_s3_bucket_public_access_block.trail]
}

resource "aws_cloudtrail" "main" {
  name                          = "pexa"
  s3_bucket_name                = aws_s3_bucket.trail.id
  is_multi_region_trail         = true
  include_global_service_events = true
  enable_log_file_validation    = true
  depends_on                    = [aws_s3_bucket_policy.trail]
}

# ---- GuardDuty (eu-west-1; 30-day free trial, then usage-based) ----
resource "aws_guardduty_detector" "main" {
  enable                       = true
  finding_publishing_frequency = "SIX_HOURS"
}

# Keep the cost small: the base analysis (CloudTrail, VPC flow and DNS logs) plus Lambda network activity and
# Aurora sign-in monitoring; the per-volume extras that do not apply here stay off (docs/COSTS.md).
locals {
  guardduty_features = {
    LAMBDA_NETWORK_LOGS    = "ENABLED"
    RDS_LOGIN_EVENTS       = "ENABLED"
    S3_DATA_EVENTS         = "DISABLED"
    EKS_AUDIT_LOGS         = "DISABLED"
    EBS_MALWARE_PROTECTION = "DISABLED"
    RUNTIME_MONITORING     = "DISABLED"
  }
}

resource "aws_guardduty_detector_feature" "main" {
  for_each    = local.guardduty_features
  detector_id = aws_guardduty_detector.main.id
  name        = each.key
  status      = each.value
}

# ---- Budget alerts (the first two budgets are free) ----
resource "aws_budgets_budget" "monthly" {
  name         = "pexa-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_email]
  }
}

output "github_deploy_role_arns" {
  description = "Set these as the AWS_DEPLOY_ROLE_ARN variable of the matching GitHub environment."
  value       = { for k, r in aws_iam_role.github_deploy : k => r.arn }
}
