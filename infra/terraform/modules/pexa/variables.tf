variable "environment" {
  description = "Environment name: staging or production."
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "app_mode" {
  description = "Pexa APP_MODE. Everything deployed from this code runs in test mode; real money stays behind the go-live checklist."
  type        = string
  default     = "test"
  validation {
    condition     = var.app_mode == "test"
    error_message = "Only APP_MODE=test may be deployed. Live mode needs the go-live checklist and the owner's sign-off first."
  }
}

variable "test_auto_approve" {
  description = "Test mode only: activation payments and withdrawals pass by themselves."
  type        = bool
  default     = true
}

variable "vpc_cidr" {
  description = "Address range of the private network for the database and the database-facing functions."
  type        = string
  default     = "10.20.0.0/16"
}

variable "aurora_engine_version" {
  description = "Aurora PostgreSQL version. 17.11 supports scaling to 0 ACU in eu-west-1 (checked 2026-10-26)."
  type        = string
  default     = "17.11"
}

variable "aurora_min_acu" {
  description = "Minimum Aurora Serverless v2 capacity. 0 lets the database pause when idle."
  type        = number
  default     = 0
}

variable "aurora_max_acu" {
  description = "Maximum Aurora Serverless v2 capacity."
  type        = number
  default     = 2
}

variable "aurora_seconds_until_auto_pause" {
  description = "Idle seconds before Aurora pauses (only used when aurora_min_acu is 0)."
  type        = number
  default     = 300
}

variable "aurora_backup_retention_days" {
  description = "Automated backup retention in days."
  type        = number
  default     = 1
}

variable "deletion_protection" {
  description = "Protect the database from deletion."
  type        = bool
  default     = false
}

variable "lambda_package_dir" {
  description = "Folder built by infra/scripts/package-lambda.mjs."
  type        = string
}

variable "lambda_runtime" {
  description = "Lambda Node.js runtime."
  type        = string
  default     = "nodejs22.x"
}

variable "api_memory_mb" {
  description = "Memory for the API function (CPU scales with it)."
  type        = number
  default     = 1024
}

variable "reconciliation_schedule" {
  description = "How often the balance check runs. Each run wakes the database, so a short interval stops it from pausing."
  type        = string
  default     = "rate(1 hour)"
}

variable "cleanup_schedule" {
  description = "When the daily clean-up job runs (UTC)."
  type        = string
  default     = "cron(17 3 * * ? *)"
}

variable "log_retention_days" {
  description = "CloudWatch log retention."
  type        = number
  default     = 14
}

variable "alarm_email" {
  description = "Email address for alarms (confirm the subscription email AWS sends)."
  type        = string
}

variable "mail_from" {
  description = "Sender for outgoing email. The pexerearn.com domain must be verified in Resend (docs/DOMAIN.md)."
  type        = string
  default     = "Pexerearn <info@pexerearn.com>"
}

variable "fx_fetch_schedule" {
  description = "When fxfetch fetches exchange rates into S3 (the provider updates once a day)."
  type        = string
  default     = "cron(10 */6 * * ? *)"
}

variable "fx_rates_schedule" {
  description = "When the fxrates job stores the fetched rates and pays referral rewards waiting for one."
  type        = string
  default     = "cron(20 */6 * * ? *)"
}

variable "cloudfront_price_class" {
  description = "PriceClass_All includes the African edge locations closest to members in Uganda."
  type        = string
  default     = "PriceClass_All"
}

variable "api_throttle_rate" {
  description = "Steady requests per second allowed through the API."
  type        = number
  default     = 50
}

variable "api_throttle_burst" {
  description = "Burst requests allowed through the API."
  type        = number
  default     = 100
}

variable "site_domain" {
  description = "Custom address of the site, for example staging.pexerearn.com. Empty: only the CloudFront link."
  type        = string
  default     = ""
}

variable "api_domain" {
  description = "Custom address of the API for direct clients, for example api-staging.pexerearn.com. Empty: none."
  type        = string
  default     = ""
}

variable "custom_domain_live" {
  description = <<-EOT
    Two-step setup (docs/DOMAIN.md). false: create the certificates only and output the DNS validation records.
    true (after the records are added and the certificates show ISSUED): attach the domains to CloudFront and API
    Gateway and make the site address the app's PUBLIC_ORIGIN.
  EOT
  type        = bool
  default     = false
}

variable "keep_temporary_links" {
  description = "Keep accepting the temporary CloudFront link as a site address after the custom domain is live."
  type        = bool
  default     = true
}
