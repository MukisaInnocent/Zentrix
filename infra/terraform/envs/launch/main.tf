# The launch countdown on pexerearn.com and www.pexerearn.com until the real site opens (owner, 2026-10-29:
# launch on 2 November 2026, 00:00 East Africa Time). A private S3 bucket behind CloudFront; the page is in
# infra/launch. Run with $env:AWS_PROFILE = "Pexerearn".
#
# Two steps, like the staging domain (docs/DOMAIN.md):
#   1. domain_live = false: creates the bucket, the page and the certificate. Add the validation CNAMEs from the
#      output in Cloudflare (DNS only) and wait until the certificate is ISSUED.
#   2. domain_live = true: attaches pexerearn.com and www to CloudFront. Then point both names at
#      cloudfront_domain in Cloudflare (CNAME, DNS only).
# On launch day the production site takes the names over: set domain_live = false here (or destroy this stack)
# before production attaches them, because CloudFront allows a name on one distribution only.
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
    key          = "pexa/launch/terraform.tfstate"
    region       = "eu-west-1"
    encrypt      = true
    use_lockfile = true
  }
}

locals {
  tags = {
    Project     = "Pexa"
    Environment = "launch"
    ManagedBy   = "Terraform"
    Repository  = "MukisaInnocent/Zentrix"
  }
  names     = ["pexerearn.com", "www.pexerearn.com"]
  page_dir  = "${path.module}/../../../launch"
  mime      = { html = "text/html; charset=utf-8", css = "text/css; charset=utf-8", js = "text/javascript; charset=utf-8", svg = "image/svg+xml", ics = "text/calendar; charset=utf-8", png = "image/png", txt = "text/plain; charset=utf-8", xml = "application/xml; charset=utf-8" }
  page_file = fileset(local.page_dir, "*.{html,css,js,svg,ics,png,txt,xml}")
}

provider "aws" {
  region = "eu-west-1"
  default_tags {
    tags = local.tags
  }
}

# CloudFront certificates must be in us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = local.tags
  }
}

# Live since 2026-10-29 (both steps done). Set false on launch day, before production attaches the names.
variable "domain_live" {
  description = "Step 2: attach pexerearn.com and www once the certificate is ISSUED."
  type        = bool
  default     = true
}

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "page" {
  bucket        = "pexa-launch-${data.aws_caller_identity.current.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "page" {
  bucket                  = aws_s3_bucket.page.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "page" {
  bucket = aws_s3_bucket.page.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "page" {
  bucket = aws_s3_bucket.page.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_object" "page" {
  for_each      = local.page_file
  bucket        = aws_s3_bucket.page.id
  key           = each.value
  source        = "${local.page_dir}/${each.value}"
  etag          = filemd5("${local.page_dir}/${each.value}")
  content_type  = local.mime[reverse(split(".", each.value))[0]]
  cache_control = "public, max-age=300"
}

resource "aws_cloudfront_origin_access_control" "page" {
  name                              = "pexa-launch"
  description                       = "Pexerearn launch countdown"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_s3_bucket_policy" "page" {
  bucket = aws_s3_bucket.page.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "CloudFrontReadsThePage"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.page.arn}/*"
      Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.page.arn } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.page]
}

# One address for search engines: www.pexerearn.com answers with a permanent redirect to pexerearn.com.
resource "aws_cloudfront_function" "www_redirect" {
  name    = "pexa-launch-www-redirect"
  runtime = "cloudfront-js-2.0"
  comment = "Redirect www.pexerearn.com to pexerearn.com"
  publish = true
  code    = <<-JS
    function handler(event) {
      var request = event.request;
      var host = request.headers.host ? request.headers.host.value : '';
      if (host.indexOf('www.') === 0) {
        return { statusCode: 301, statusDescription: 'Moved Permanently', headers: { location: { value: 'https://' + host.substring(4) + request.uri } } };
      }
      return request;
    }
  JS
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

# Same security headers as the site (modules/pexa/cdn.tf). The page has no inline script or style.
resource "aws_cloudfront_response_headers_policy" "page" {
  name = "pexa-launch-security"
  security_headers_config {
    content_security_policy {
      content_security_policy = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests"
      override                = true
    }
    strict_transport_security {
      access_control_max_age_sec = 31536000
      override                   = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
  }
}

resource "aws_acm_certificate" "page" {
  provider                  = aws.us_east_1
  domain_name               = local.names[0]
  subject_alternative_names = slice(local.names, 1, length(local.names))
  validation_method         = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate_validation" "page" {
  count                   = var.domain_live ? 1 : 0
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.page.arn
  validation_record_fqdns = [for o in aws_acm_certificate.page.domain_validation_options : o.resource_record_name]
}

resource "aws_cloudfront_distribution" "page" {
  enabled             = true
  comment             = "Pexerearn launch countdown"
  default_root_object = "index.html"
  price_class         = "PriceClass_All"
  http_version        = "http2and3"
  is_ipv6_enabled     = true
  aliases             = var.domain_live ? local.names : []

  origin {
    origin_id                = "page"
    domain_name              = aws_s3_bucket.page.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.page.id
  }

  default_cache_behavior {
    target_origin_id           = "page"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.page.id
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.www_redirect.arn
    }
  }

  # Any other address (an old link, /register.html) shows the countdown too.
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 60
  }
  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 60
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = !var.domain_live
    acm_certificate_arn            = var.domain_live ? aws_acm_certificate_validation.page[0].certificate_arn : null
    ssl_support_method             = var.domain_live ? "sni-only" : null
    minimum_protocol_version       = var.domain_live ? "TLSv1.2_2021" : null
  }
}

output "cloudfront_domain" {
  description = "Point pexerearn.com and www.pexerearn.com here (CNAME, DNS only) after step 2."
  value       = aws_cloudfront_distribution.page.domain_name
}

output "distribution_id" {
  description = "For cache invalidation after changing the page."
  value       = aws_cloudfront_distribution.page.id
}

output "certificate_validation" {
  description = "Add these CNAMEs in Cloudflare (DNS only) for step 1."
  value = [for o in aws_acm_certificate.page.domain_validation_options : {
    name  = o.resource_record_name
    type  = o.resource_record_type
    value = o.resource_record_value
  }]
}
