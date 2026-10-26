# Pexa production (not created yet: apply only after staging is approved). Still test mode until the go-live checklist. Run with $env:AWS_PROFILE = "Pexerearn" (docs/DEPLOYMENT.md).
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
      AppMode     = "test"
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
      AppMode     = "test"
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
  app_mode                     = "test"
  alarm_email                  = var.alarm_email
  lambda_package_dir           = var.lambda_package_dir
  aurora_min_acu               = 0
  aurora_max_acu               = 4
  deletion_protection          = true
  aurora_backup_retention_days = 7
  reconciliation_schedule      = "rate(15 minutes)"
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
