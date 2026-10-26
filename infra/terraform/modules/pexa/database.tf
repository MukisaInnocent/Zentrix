# Aurora Serverless v2 PostgreSQL. All money data (ledger, balances, payments) lives here. With a minimum of
# 0 ACU the database pauses after aurora_seconds_until_auto_pause idle seconds and resumes on the next
# connection (about 15 seconds; the functions wait up to 25).
resource "random_password" "db" {
  length  = 40
  special = false
}

resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_rds_cluster" "main" {
  cluster_identifier              = local.name
  engine                          = "aurora-postgresql"
  engine_mode                     = "provisioned"
  engine_version                  = var.aurora_engine_version
  database_name                   = "pexa"
  master_username                 = "pexa_owner"
  master_password                 = random_password.db.result
  db_subnet_group_name            = aws_db_subnet_group.main.name
  vpc_security_group_ids          = [aws_security_group.db.id]
  storage_encrypted               = true
  backup_retention_period         = var.aurora_backup_retention_days
  preferred_backup_window         = "01:00-02:00"
  deletion_protection             = var.deletion_protection
  skip_final_snapshot             = !var.deletion_protection
  final_snapshot_identifier       = var.deletion_protection ? "${local.name}-final" : null
  copy_tags_to_snapshot           = true
  enabled_cloudwatch_logs_exports = []

  serverlessv2_scaling_configuration {
    min_capacity             = var.aurora_min_acu
    max_capacity             = var.aurora_max_acu
    seconds_until_auto_pause = var.aurora_min_acu == 0 ? var.aurora_seconds_until_auto_pause : null
  }
}

resource "aws_rds_cluster_instance" "writer" {
  identifier                   = "${local.name}-writer"
  cluster_identifier           = aws_rds_cluster.main.id
  instance_class               = "db.serverless"
  engine                       = aws_rds_cluster.main.engine
  engine_version               = aws_rds_cluster.main.engine_version
  db_subnet_group_name         = aws_db_subnet_group.main.name
  performance_insights_enabled = false
  auto_minor_version_upgrade   = true
}

locals {
  # The owner connection (migrations); the API and jobs switch to the restricted zentrix_app role on connect.
  database_url = "postgres://pexa_owner:${random_password.db.result}@${aws_rds_cluster.main.endpoint}:5432/pexa"
}
