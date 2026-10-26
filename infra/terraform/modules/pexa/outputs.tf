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
