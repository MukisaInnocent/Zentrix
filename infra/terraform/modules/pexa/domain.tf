# Custom domains with DNS at Cloudflare (no Route 53 zone). Two applies (docs/DOMAIN.md):
#   1. custom_domain_live = false: request the certificates; the outputs list the validation CNAMEs to add in
#      Cloudflare.
#   2. custom_domain_live = true, once both certificates show ISSUED: attach the site domain to CloudFront and the
#      API domain to API Gateway, and make the site domain the app's PUBLIC_ORIGIN.
# Public ACM certificates, API Gateway custom domains and CloudFront alternate domain names (SNI) are free.
locals {
  has_site_domain = var.site_domain != ""
  has_api_domain  = var.api_domain != ""
  site_live       = local.has_site_domain && var.custom_domain_live
  api_live        = local.has_api_domain && var.custom_domain_live
  cloudfront_url  = "https://${aws_cloudfront_distribution.main.domain_name}"
}

# CloudFront only accepts certificates from us-east-1.
resource "aws_acm_certificate" "site" {
  count             = local.has_site_domain ? 1 : 0
  provider          = aws.us_east_1
  domain_name       = var.site_domain
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

# A regional API Gateway custom domain uses a certificate from its own region (eu-west-1).
resource "aws_acm_certificate" "api" {
  count             = local.has_api_domain ? 1 : 0
  domain_name       = var.api_domain
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

# These wait until ACM sees the validation records (step 2 only, so step 1 never blocks).
resource "aws_acm_certificate_validation" "site" {
  count                   = local.site_live ? 1 : 0
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.site[0].arn
  validation_record_fqdns = [for o in aws_acm_certificate.site[0].domain_validation_options : o.resource_record_name]
  timeouts {
    create = "20m"
  }
}

resource "aws_acm_certificate_validation" "api" {
  count                   = local.api_live ? 1 : 0
  certificate_arn         = aws_acm_certificate.api[0].arn
  validation_record_fqdns = [for o in aws_acm_certificate.api[0].domain_validation_options : o.resource_record_name]
  timeouts {
    create = "20m"
  }
}

resource "aws_apigatewayv2_domain_name" "api" {
  count       = local.api_live ? 1 : 0
  domain_name = var.api_domain
  domain_name_configuration {
    certificate_arn = aws_acm_certificate_validation.api[0].certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
}

resource "aws_apigatewayv2_api_mapping" "api" {
  count       = local.api_live ? 1 : 0
  api_id      = aws_apigatewayv2_api.main.id
  domain_name = aws_apigatewayv2_domain_name.api[0].id
  stage       = aws_apigatewayv2_stage.default.id
}

# The records to add in Cloudflare (ACM names and values end in a dot; Cloudflare wants them without).
locals {
  validation_records = concat(
    [for o in try(aws_acm_certificate.site[0].domain_validation_options, []) : {
      purpose = "Certificate check for ${var.site_domain} (us-east-1)"
      name    = trimsuffix(o.resource_record_name, ".")
      type    = o.resource_record_type
      value   = trimsuffix(o.resource_record_value, ".")
      proxy   = "DNS only (grey cloud)"
    }],
    [for o in try(aws_acm_certificate.api[0].domain_validation_options, []) : {
      purpose = "Certificate check for ${var.api_domain} (eu-west-1)"
      name    = trimsuffix(o.resource_record_name, ".")
      type    = o.resource_record_type
      value   = trimsuffix(o.resource_record_value, ".")
      proxy   = "DNS only (grey cloud)"
    }],
  )
  traffic_records = concat(
    local.has_site_domain ? [{
      purpose = "Site"
      name    = var.site_domain
      type    = "CNAME"
      value   = aws_cloudfront_distribution.main.domain_name
      proxy   = "DNS only (grey cloud)"
    }] : [],
    local.has_api_domain ? [{
      purpose = "API"
      name    = var.api_domain
      type    = "CNAME"
      value   = local.api_live ? aws_apigatewayv2_domain_name.api[0].domain_name_configuration[0].target_domain_name : "(shown after the second apply)"
      proxy   = "DNS only (grey cloud)"
    }] : [],
  )
}
