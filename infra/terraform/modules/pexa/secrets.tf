# Secrets live in Secrets Manager (encrypted with the AWS-managed key). The functions inside the VPC have no
# route to Secrets Manager (no NAT, no paid endpoints), so Terraform reads the values at deploy time and passes
# them as Lambda environment variables, which Lambda encrypts at rest. Changing a secret needs a redeploy.
#
# The app secret is generated on first apply. Add or change values (for example RESEND_API_KEY) with
# `aws secretsmanager put-secret-value` (docs/DEPLOYMENT.md); Terraform keeps whatever is stored there.

resource "aws_secretsmanager_secret" "db" {
  name                    = "${local.name}/database"
  description             = "Pexa ${var.environment} Aurora owner credentials"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    username = aws_rds_cluster.main.master_username
    password = random_password.db.result
    host     = aws_rds_cluster.main.endpoint
    port     = 5432
    dbname   = aws_rds_cluster.main.database_name
  })
}

resource "random_password" "csrf" {
  length  = 64
  special = false
}

resource "random_bytes" "data_key" {
  length = 32
}

resource "random_password" "superadmin" {
  length  = 24
  special = false
}

resource "random_password" "seed_staff" {
  length  = 20
  special = false
}

resource "random_password" "seed_member" {
  length  = 12
  special = false
}

resource "aws_secretsmanager_secret" "app" {
  name                    = "${local.name}/app"
  description             = "Pexa ${var.environment} application secrets"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    CSRF_SECRET              = random_password.csrf.result
    DATA_ENCRYPTION_KEY      = random_bytes.data_key.base64
    TEST_SUPERADMIN_PASSWORD = "Sa-${random_password.superadmin.result}-9!"
    SEED_STAFF_PASSWORD      = "Staff-${random_password.seed_staff.result}-7!"
    SEED_MEMBER_PASSWORD     = random_password.seed_member.result
    RESEND_API_KEY           = ""
  })
  # Values edited outside Terraform (RESEND_API_KEY, rotated passwords) are kept; refresh reads them back.
  lifecycle {
    ignore_changes = [secret_string]
  }
}

# The current version: the resource above keeps pointing at the version Terraform first wrote, so values added
# later with put-secret-value (RESEND_API_KEY, rotated passwords) are read from here.
data "aws_secretsmanager_secret_version" "app" {
  secret_id  = aws_secretsmanager_secret.app.id
  depends_on = [aws_secretsmanager_secret_version.app]
}

locals {
  app_secret = jsondecode(data.aws_secretsmanager_secret_version.app.secret_string)
  # Email goes through S3 and the mailer function only when a Resend key is stored; otherwise the test-mode
  # Email outbox staff page shows every message.
  # Only the yes/no answer is used to decide which resources exist, so it is safe to reveal.
  resend_enabled = nonsensitive(try(local.app_secret.RESEND_API_KEY, "") != "")
}
