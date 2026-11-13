# A NAT instance instead of the managed NAT gateway (livepay_nat_type = "instance"; owner, 2026-11-13, to cut costs).
# One t4g.nano in the public subnet forwards paygate's HTTPS calls to the internet from the same Elastic IP, so the
# LivePay whitelist does not change. It forwards only HTTPS from the paygate subnet; nothing else can reach it, it has
# no SSH key (Session Manager only), and it needs IMDSv2.
#
# If it fails, paygate's calls fail: payouts go to review (never auto-failed) and members retry their prompt, as with
# any LivePay outage. EC2 moves it to healthy hardware by itself (simplified automatic recovery, same IP), and the
# alarm below reboots it if the operating system stops answering.

data "aws_ssm_parameter" "al2023_arm64" {
  count = local.nat_instance
  name  = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_security_group" "nat" {
  count       = local.nat_instance
  name        = "${local.name}-nat"
  description = "Pexa NAT instance: HTTPS from paygate in, HTTPS out"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "nat_from_paygate" {
  count             = local.nat_instance
  security_group_id = aws_security_group.nat[0].id
  cidr_ipv4         = aws_subnet.egress[0].cidr_block
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS from the paygate subnet"
}

resource "aws_vpc_security_group_egress_rule" "nat_https" {
  count             = local.nat_instance
  security_group_id = aws_security_group.nat[0].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS to LivePay, package updates and Session Manager"
}

data "aws_iam_policy_document" "nat_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "nat" {
  count              = local.nat_instance
  name               = "${local.name}-nat"
  assume_role_policy = data.aws_iam_policy_document.nat_assume.json
}

# Session Manager only, for looking at the instance without SSH.
resource "aws_iam_role_policy_attachment" "nat_ssm" {
  count      = local.nat_instance
  role       = aws_iam_role.nat[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "nat" {
  count = local.nat_instance
  name  = "${local.name}-nat"
  role  = aws_iam_role.nat[0].name
}

resource "aws_instance" "nat" {
  count                  = local.nat_instance
  ami                    = data.aws_ssm_parameter.al2023_arm64[0].value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.public[0].id
  vpc_security_group_ids = [aws_security_group.nat[0].id]
  iam_instance_profile   = aws_iam_instance_profile.nat[0].name
  source_dest_check      = false
  # A temporary public address so it can install nftables before the Elastic IP is attached; the Elastic IP
  # replaces it.
  associate_public_ip_address = true

  credit_specification {
    cpu_credits = "standard"
  }

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 8
    encrypted   = true
  }

  maintenance_options {
    auto_recovery = "default"
  }

  # Runs on first boot; nftables and the forwarding setting persist across reboots.
  user_data = <<-EOT
    #!/bin/bash
    set -uo pipefail
    echo 'net.ipv4.ip_forward = 1' > /etc/sysctl.d/90-nat.conf
    sysctl --system
    for i in $(seq 1 30); do command -v nft && break; dnf install -y nftables && break; sleep 10; done
    IFACE=$(ip route show default | awk '{print $5; exit}')
    cat > /etc/sysconfig/nftables.conf <<EOF
    flush ruleset
    table ip nat {
      chain postrouting {
        type nat hook postrouting priority 100;
        oifname "$IFACE" ip saddr ${aws_subnet.egress[0].cidr_block} masquerade
      }
    }
    table ip filter {
      chain forward {
        type filter hook forward priority 0; policy drop;
        ct state established,related accept
        ip saddr ${aws_subnet.egress[0].cidr_block} tcp dport 443 accept
      }
    }
    EOF
    systemctl enable nftables
    systemctl restart nftables
  EOT

  tags = { Name = "${local.name}-nat" }

  lifecycle {
    # A newer image or script must not replace a running NAT (that would cut LivePay off); replace it on purpose.
    ignore_changes = [ami, user_data]
  }
}

resource "aws_eip_association" "nat" {
  count         = local.nat_instance
  allocation_id = aws_eip.livepay[0].id
  instance_id   = aws_instance.nat[0].id
}

# Reboot when the operating system stops answering (hardware failures are recovered by EC2 itself).
resource "aws_cloudwatch_metric_alarm" "nat_instance_check" {
  count               = local.nat_instance
  alarm_name          = "${local.name}-nat-instance-check"
  alarm_description   = "Pexa ${var.environment}: the LivePay NAT instance failed its status check and is being rebooted; LivePay calls fail until it is back."
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed_Instance"
  dimensions          = { InstanceId = aws_instance.nat[0].id }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = ["arn:aws:automate:${data.aws_region.current.region}:ec2:reboot", aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}
