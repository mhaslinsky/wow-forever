data "archive_file" "departure_snapshot" {
  type        = "zip"
  source_dir  = "${path.module}/../build/departure-snapshot"
  output_path = "${path.module}/.terraform/tmp/departure-snapshot.zip"
}
resource "aws_cloudwatch_log_group" "departure_snapshot" {
  name              = "/aws/lambda/wow-forever-departure-snapshot"
  retention_in_days = 14
}
resource "aws_iam_role" "departure_snapshot" {
  name               = "wow-forever-departure-snapshot"
  assume_role_policy = data.aws_iam_policy_document.interactions_assume.json
}
data "aws_iam_policy_document" "departure_snapshot" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.departure_snapshot.arn}:*"]
  }
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.guild.arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["DEPARTURE#${var.guild_id}", "DEPARTURE_CHECK#${var.guild_id}"]
    }
  }
  statement {
    actions   = ["dynamodb:GetItem"]
    resources = [aws_dynamodb_table.guild.arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["SNAPSHOT#${coalesce(var.guildos_guild_key, "unconfigured")}", "SNAPSHOT_LATEST#${coalesce(var.guildos_guild_key, "unconfigured")}"]
    }
  }
  statement {
    actions   = ["dynamodb:Query"]
    resources = ["${aws_dynamodb_table.guild.arn}/index/gsi1"]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["MEMBER#ALL"]
    }
  }
  statement {
    actions   = ["dynamodb:Query", "dynamodb:PutItem"]
    resources = [aws_dynamodb_table.guild.arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["LOOT_DECISION#${var.guild_id}"]
    }
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
}
resource "aws_iam_role_policy" "departure_snapshot" {
  role   = aws_iam_role.departure_snapshot.id
  policy = data.aws_iam_policy_document.departure_snapshot.json
}
resource "aws_lambda_function" "departure_snapshot" {
  function_name                  = "wow-forever-departure-snapshot"
  role                           = aws_iam_role.departure_snapshot.arn
  runtime                        = "nodejs22.x"
  handler                        = "index.handler"
  architectures                  = ["arm64"]
  filename                       = data.archive_file.departure_snapshot.output_path
  source_code_hash               = data.archive_file.departure_snapshot.output_base64sha256
  timeout                        = 300
  reserved_concurrent_executions = 1
  memory_size                    = 256
  environment {
    variables = {
      GUILD_ID          = var.guild_id
      GUILD_TABLE       = aws_dynamodb_table.guild.name
      GUILDOS_GUILD_KEY = coalesce(var.guildos_guild_key, "unconfigured")
    }
  }
  depends_on = [aws_cloudwatch_log_group.departure_snapshot, aws_iam_role_policy.departure_snapshot]
}
resource "aws_lambda_function_event_invoke_config" "departure_snapshot" {
  function_name                = aws_lambda_function.departure_snapshot.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 600
}
data "aws_iam_policy_document" "departure_snapshot_scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.aws_account_id]
    }
  }
}
resource "aws_iam_role" "departure_snapshot_scheduler" {
  name               = "wow-forever-departure-snapshot-scheduler"
  assume_role_policy = data.aws_iam_policy_document.departure_snapshot_scheduler_assume.json
}
data "aws_iam_policy_document" "departure_snapshot_scheduler" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.departure_snapshot.arn]
  }
}
resource "aws_iam_role_policy" "departure_snapshot_scheduler" {
  role   = aws_iam_role.departure_snapshot_scheduler.id
  policy = data.aws_iam_policy_document.departure_snapshot_scheduler.json
}
resource "aws_scheduler_schedule_group" "departure_snapshot" {
  name = "wow-forever-departure-snapshot"
}
resource "aws_scheduler_schedule" "departure_snapshot" {
  name                         = "wow-forever-departure-snapshot"
  group_name                   = aws_scheduler_schedule_group.departure_snapshot.name
  state                        = var.guildos_guild_key == null ? "DISABLED" : (trimspace(var.guildos_guild_key) != "" ? "ENABLED" : "DISABLED")
  schedule_expression          = "rate(5 minutes)"
  schedule_expression_timezone = "America/New_York"
  flexible_time_window { mode = "OFF" }
  target {
    arn      = aws_lambda_function.departure_snapshot.arn
    role_arn = aws_iam_role.departure_snapshot_scheduler.arn
    input    = "{}"
    retry_policy {
      maximum_retry_attempts       = 0
      maximum_event_age_in_seconds = 600
    }
  }
  depends_on = [aws_iam_role_policy.departure_snapshot_scheduler]
}
resource "aws_cloudwatch_metric_alarm" "departure_snapshot_errors" {
  alarm_name          = "wow-forever-departure-snapshot-errors"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  dimensions          = { FunctionName = aws_lambda_function.departure_snapshot.function_name }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "departure_snapshot_delivery_errors" {
  alarm_name          = "wow-forever-departure-snapshot-delivery-errors"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "TargetErrorCount"
  namespace           = "AWS/Scheduler"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  dimensions          = { ScheduleGroup = aws_scheduler_schedule_group.departure_snapshot.name }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
