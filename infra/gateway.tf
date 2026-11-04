locals { gateway_name = "wow-forever-gateway" }

data "aws_ssm_parameter" "gateway_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}
data "aws_vpc" "gateway" { default = true }
data "aws_subnets" "gateway" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.gateway.id]
  }
}
resource "aws_security_group" "gateway" {
  name   = local.gateway_name
  vpc_id = data.aws_vpc.gateway.id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_s3_bucket" "gateway" { bucket = "wow-forever-gateway-${var.aws_account_id}" }
resource "aws_s3_bucket_public_access_block" "gateway" {
  bucket                  = aws_s3_bucket.gateway.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "gateway" {
  bucket = aws_s3_bucket.gateway.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
data "aws_iam_policy_document" "gateway_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}
resource "aws_iam_role" "gateway" {
  name               = local.gateway_name
  assume_role_policy = data.aws_iam_policy_document.gateway_assume.json
}
resource "aws_iam_instance_profile" "gateway" {
  name = local.gateway_name
  role = aws_iam_role.gateway.name
}
data "aws_iam_policy_document" "gateway" {
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.guild.arn]
  }
  statement {
    actions = [
      "ssm:UpdateInstanceInformation", "ssm:ListAssociations", "ssm:ListInstanceAssociations",
      "ssm:DescribeAssociation", "ssm:GetDocument", "ssm:DescribeDocument",
      "ssm:UpdateAssociationStatus", "ssm:UpdateInstanceAssociationStatus", "ssm:PutInventory",
      "ssm:GetDeployablePatchSnapshotForInstance", "ec2messages:*", "ssmmessages:*"
    ]
    resources = ["*"]
  }
  statement {
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.secrets["discord_bot_token"].arn]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [data.aws_kms_key.ssm.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.us-east-1.amazonaws.com"]
    }
  }
  statement {
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["wow-forever/gateway"]
    }
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.gateway.arn]
  }
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.gateway.arn}/artifacts/gateway/*"]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams", "logs:DescribeLogGroups"]
    resources = [aws_cloudwatch_log_group.gateway.arn, "${aws_cloudwatch_log_group.gateway.arn}:*"]
  }
}
resource "aws_iam_role_policy" "gateway" {
  role   = aws_iam_role.gateway.id
  policy = data.aws_iam_policy_document.gateway.json
}
resource "aws_cloudwatch_log_group" "gateway" {
  name              = "/wow-forever/gateway"
  retention_in_days = 14
}
resource "aws_instance" "gateway" {
  ami = data.aws_ssm_parameter.gateway_ami.value
  lifecycle { ignore_changes = [ami] }
  instance_type               = "t4g.nano"
  subnet_id                   = sort(data.aws_subnets.gateway.ids)[0]
  associate_public_ip_address = true
  vpc_security_group_ids      = [aws_security_group.gateway.id]
  iam_instance_profile        = aws_iam_instance_profile.gateway.name
  user_data_replace_on_change = true
  metadata_options { http_tokens = "required" }
  root_block_device {
    volume_size = 8
    volume_type = "gp3"
    encrypted   = true
  }
  user_data = join("\n", ["#cloud-config", yamlencode({
    # dnf is OOM-killed loading repo metadata in 512 MB of RAM; swap is set up before packages install.
    swap           = { filename = "/swapfile", size = 1073741824, maxsize = 1073741824 }
    package_update = true
    packages       = ["nodejs22", "amazon-cloudwatch-agent"]
    users          = [{ name = "gateway", system = true, shell = "/sbin/nologin" }]
    write_files = [
      {
        path    = "/etc/systemd/system/wow-forever-gateway.service"
        content = <<-UNIT
          [Unit]
          Description=Discord gateway
          After=network-online.target
          Wants=network-online.target
          ConditionPathExists=/opt/wow-forever-gateway/index.mjs
          [Service]
          User=gateway
          EnvironmentFile=/opt/wow-forever-gateway/environment
          LogsDirectory=wow-forever-gateway
          ExecStart=/usr/bin/node-22 /opt/wow-forever-gateway/index.mjs
          Restart=always
          RestartSec=10
          NoNewPrivileges=true
          ProtectSystem=strict
          ProtectHome=true
          StandardOutput=append:/var/log/wow-forever-gateway/gateway.log
          StandardError=append:/var/log/wow-forever-gateway/gateway.log
          [Install]
          WantedBy=multi-user.target
        UNIT
      },
      {
        path    = "/opt/wow-forever-gateway/bootstrap.mts"
        content = file("${path.module}/../scripts/gateway-bootstrap.mts")
      },
      {
        path = "/opt/aws/amazon-cloudwatch-agent/etc/gateway.json"
        content = jsonencode({ logs = { logs_collected = { files = { collect_list = [{
          file_path = "/var/log/wow-forever-gateway/gateway.log", log_group_name = aws_cloudwatch_log_group.gateway.name, log_stream_name = "{instance_id}"
        }] } } } })
      },
      {
        path    = "/etc/logrotate.d/wow-forever-gateway"
        content = "/var/log/wow-forever-gateway/gateway.log {\n daily\n rotate 3\n size 10M\n copytruncate\n missingok\n}\n"
      }
    ]
    runcmd = [
      ["install", "-d", "-m", "0755", "/opt/wow-forever-gateway"],
      # systemd opens the append: log file before LogsDirectory= creates its directory.
      ["install", "-d", "-m", "0750", "-o", "gateway", "-g", "gateway", "/var/log/wow-forever-gateway"],
      ["systemctl", "daemon-reload"],
      ["/usr/bin/node-22", "--experimental-strip-types", "/opt/wow-forever-gateway/bootstrap.mts", aws_s3_bucket.gateway.id],
      ["/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl", "-a", "fetch-config", "-m", "ec2", "-c", "file:/opt/aws/amazon-cloudwatch-agent/etc/gateway.json", "-s"]
    ]
  })])
  tags       = { Name = local.gateway_name }
  depends_on = [aws_iam_role_policy.gateway]
}
resource "aws_cloudwatch_metric_alarm" "gateway_silence" {
  alarm_name          = "wow-forever-gateway-silence"
  namespace           = "wow-forever/gateway"
  metric_name         = "Heartbeat"
  dimensions          = { InstanceId = aws_instance.gateway.id }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 10
  datapoints_to_alarm = 10
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
output "gateway_instance_id" { value = aws_instance.gateway.id }
output "gateway_artifact_bucket" { value = aws_s3_bucket.gateway.id }
