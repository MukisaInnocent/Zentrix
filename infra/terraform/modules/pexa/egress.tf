# A fixed outgoing address for LivePay (owner, 2026-10-30). LivePay accepts API calls only from whitelisted IPs, and
# a Lambda function has no fixed address. Only the paygate function leaves through this NAT gateway; the API and the
# database stay without internet.
#
#   livepay_fixed_ip = true   keeps the Elastic IP (about USD 3.60 a month), so the LivePay whitelist never changes;
#   livepay_nat      = true   runs the NAT gateway (about USD 35 a month, billed by the hour) and puts paygate behind
#                             it. Switch it on while LivePay is in use and off otherwise.
locals {
  fixed_ip = var.livepay_fixed_ip || var.livepay_nat ? 1 : 0
  nat      = var.livepay_nat ? 1 : 0
}

resource "aws_eip" "livepay" {
  count  = local.fixed_ip
  domain = "vpc"
  tags   = { Name = "${local.name}-livepay" }
}

resource "aws_internet_gateway" "main" {
  count  = local.nat
  vpc_id = aws_vpc.main.id
  tags   = { Name = local.name }
}

# One availability zone is enough: if it fails, commands wait in the queue and are retried.
resource "aws_subnet" "public" {
  count             = local.nat
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, 14)
  availability_zone = data.aws_availability_zones.available.names[0]
  tags              = { Name = "${local.name}-public" }
}

resource "aws_route_table" "public" {
  count  = local.nat
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main[0].id
  }
  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table_association" "public" {
  count          = local.nat
  subnet_id      = aws_subnet.public[0].id
  route_table_id = aws_route_table.public[0].id
}

resource "aws_nat_gateway" "livepay" {
  count         = local.nat
  allocation_id = aws_eip.livepay[0].id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = "${local.name}-livepay" }
  depends_on    = [aws_internet_gateway.main]
}

# The paygate function's own subnet: internet through the NAT, S3 through the free gateway endpoint.
resource "aws_subnet" "egress" {
  count             = local.nat
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, 15)
  availability_zone = data.aws_availability_zones.available.names[0]
  tags              = { Name = "${local.name}-egress" }
}

resource "aws_route_table" "egress" {
  count  = local.nat
  vpc_id = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.livepay[0].id
  }
  tags = { Name = "${local.name}-egress" }
}

resource "aws_route_table_association" "egress" {
  count          = local.nat
  subnet_id      = aws_subnet.egress[0].id
  route_table_id = aws_route_table.egress[0].id
}

resource "aws_vpc_endpoint_route_table_association" "egress_s3" {
  count           = local.nat
  vpc_endpoint_id = aws_vpc_endpoint.s3.id
  route_table_id  = aws_route_table.egress[0].id
}

# paygate may only make HTTPS calls (LivePay, and S3 through the endpoint). Nothing can connect to it.
resource "aws_security_group" "paygate" {
  count       = local.nat
  name        = "${local.name}-paygate"
  description = "Pexa paygate function: HTTPS out only"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_egress_rule" "paygate_https" {
  count             = local.nat
  security_group_id = aws_security_group.paygate[0].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS to LivePay and S3"
}
