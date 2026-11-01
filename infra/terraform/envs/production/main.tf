# Pexa production, live mode (owner, 2026-11-01): real money. The API refuses to start until the go-live checklist is
# signed on this database (infra/scripts/golive.ps1). Run with $env:AWS_PROFILE = "Pexerearn" (docs/DEPLOYMENT.md, "Going live").
terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
  # State in the existing versioned bucket; use_lockfile is S3-native state locking (no DynamoDB table).
  backend "s3" {
    bucket       = "pexerearn-tfstate-48213"
    key          = "pexa/production/terraform.tfstate"
    region       = "eu-west-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = "eu-west-1"
  default_tags {
    tags = {
      Project     = "Pexa"
      Environment = "production"
      AppMode     = "live"
      ManagedBy   = "Terraform"
      Repository  = "MukisaInnocent/Zentrix"
    }
  }
}

# us-east-1, only for the CloudFront certificate (an AWS requirement). Everything else stays in eu-west-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = {
      Project     = "Pexa"
      Environment = "production"
      AppMode     = "live"
      ManagedBy   = "Terraform"
      Repository  = "MukisaInnocent/Zentrix"
    }
  }
}

variable "alarm_email" {
  description = "Where alarm emails go."
  type        = string
}

variable "lambda_package_dir" {
  description = "Folder built by infra/scripts/package-lambda.mjs."
  type        = string
  default     = "../../../../.lambda/package"
}

module "pexa" {
  source = "../../modules/pexa"
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }
  environment                  = "production"
  app_mode                     = "live"
  alarm_email                  = var.alarm_email
  lambda_package_dir           = var.lambda_package_dir
  aurora_min_acu               = 0
  aurora_max_acu               = 4
  deletion_protection          = true
  aurora_backup_retention_days = 7
  reconciliation_schedule      = "rate(15 minutes)"

  # pexerearn.com (docs/DOMAIN.md). Step 1: false (certificates only). The launch countdown holds the name until
  # 2 November 2026 00:00 EAT; take it off there first, then set true here and apply again.
  site_domain        = "pexerearn.com"
  api_domain         = "api.pexerearn.com"
  custom_domain_live = false

  # LivePay (docs/LIVEPAY.md) with the fixed IP LivePay whitelists; the NAT gateway (about USD 35 a month) must run
  # for payments to go through.
  livepay_enabled  = true
  livepay_fixed_ip = true
  livepay_nat      = true
  # Owner, 2026-11-01: check open LivePay payments every minute (the scheduler's minimum), not every 5.
  payments_schedule = "rate(1 minute)"
}

output "site_url" {
  value = module.pexa.site_url
}

output "cloudfront_distribution_id" {
  value = module.pexa.cloudfront_distribution_id
}

output "web_bucket" {
  value = module.pexa.web_bucket
}

output "migrate_function" {
  value = module.pexa.migrate_function
}

output "app_secret_name" {
  value = module.pexa.app_secret_name
}

output "email_delivery" {
  value = module.pexa.email_delivery
}

output "temporary_site_url" {
  value = module.pexa.temporary_site_url
}

output "livepay_fixed_ip" {
  value = module.pexa.livepay_fixed_ip
}

output "api_url" {
  value = module.pexa.api_url
}

output "certificate_status" {
  value = module.pexa.certificate_status
}

output "cloudflare_dns_records" {
  value = module.pexa.cloudflare_dns_records
}
