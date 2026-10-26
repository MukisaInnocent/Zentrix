output "site_url" {
  description = "Open this in a browser."
  value       = local.public_origin
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.main.id
}

output "web_bucket" {
  value = aws_s3_bucket.web.bucket
}

output "migrate_function" {
  value = aws_lambda_function.migrate.function_name
}

output "api_function" {
  value = aws_lambda_function.api.function_name
}

output "app_secret_name" {
  description = "Secrets Manager secret holding the app secrets (add RESEND_API_KEY here)."
  value       = aws_secretsmanager_secret.app.name
}

output "database_endpoint" {
  value = aws_rds_cluster.main.endpoint
}

output "email_delivery" {
  description = "resend: emails are sent; outbox: they appear on the staff Email outbox page."
  value       = local.resend_enabled ? "resend" : "outbox"
}

output "temporary_site_url" {
  description = "The CloudFront link, which keeps working."
  value       = local.cloudfront_url
}

output "api_url" {
  description = "The API's own address (custom domain once live, else the API Gateway link)."
  value       = local.api_live ? "https://${var.api_domain}" : aws_apigatewayv2_api.main.api_endpoint
}

output "certificate_status" {
  description = "Check with: aws acm describe-certificate (docs/DOMAIN.md)."
  value = {
    site = try(aws_acm_certificate.site[0].arn, null)
    api  = try(aws_acm_certificate.api[0].arn, null)
  }
}

output "cloudflare_dns_records" {
  description = "Records to add in Cloudflare (DNS > Records)."
  value       = concat(local.validation_records, local.traffic_records)
}

output "cloudflare_dns_table" {
  description = "The same records as a table."
  value = join("\n", concat(
    [format("%-46s %-6s %-8s %-60s %s", "PURPOSE", "TYPE", "PROXY", "NAME", "VALUE")],
    [for r in concat(local.validation_records, local.traffic_records) :
    format("%-46s %-6s %-8s %-60s %s", r.purpose, r.type, "DNS only", r.name, r.value)],
  ))
}
