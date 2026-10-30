locals {
  name = "pexa-${var.environment}"
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_availability_zones" "available" {
  state = "available"
}

# A private network with no internet gateway and no NAT gateway: only the database and the functions that use it
# live here. The free S3 gateway endpoint lets the API hand outgoing email to S3 (docs/DEPLOYMENT.md).
resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = local.name }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index)
  availability_zone = data.aws_availability_zones.available.names[count.index]
  tags              = { Name = "${local.name}-private-${count.index + 1}" }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.name}-private" }
}

resource "aws_route_table_association" "private" {
  count          = length(aws_subnet.private)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.s3"
  vpc_endpoint_type = "Gateway"
  # The paygate subnet's routes too (egress.tf), so its S3 traffic stays on the free endpoint.
  route_table_ids = concat([aws_route_table.private.id], aws_route_table.egress[*].id)
  tags            = { Name = "${local.name}-s3" }
}

resource "aws_security_group" "lambda" {
  name        = "${local.name}-lambda"
  description = "Pexa functions inside the VPC"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_egress_rule" "lambda_to_db" {
  security_group_id            = aws_security_group.lambda.id
  referenced_security_group_id = aws_security_group.db.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL"
}

resource "aws_vpc_security_group_egress_rule" "lambda_to_s3" {
  security_group_id = aws_security_group.lambda.id
  prefix_list_id    = aws_vpc_endpoint.s3.prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "S3 through the gateway endpoint (email handoff)"
}

resource "aws_security_group" "db" {
  name        = "${local.name}-db"
  description = "Pexa Aurora PostgreSQL"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "db_from_lambda" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.lambda.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL from Pexa functions"
}
