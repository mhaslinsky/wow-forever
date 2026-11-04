data "archive_file" "signups" {
  type        = "zip"
  source_dir  = "${path.module}/../build/signups"
  output_path = "${path.module}/.terraform/tmp/signups.zip"
}
resource "aws_cloudwatch_log_group" "signups" {
  name              = "/aws/lambda/wow-forever-signups"
  retention_in_days = 14
}
resource "aws_iam_role" "signups" {
  name               = "wow-forever-signups"
  assume_role_policy = data.aws_iam_policy_document.interactions_assume.json
}
data "aws_iam_policy_document" "signups" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.signups.arn}:*"]
  }
  statement {
    actions   = ["dynamodb:PutItem"]
    resources = [aws_dynamodb_table.guild.arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["SIGNUP#${var.guild_id}"]
    }
  }
  statement {
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.external_api_keys["raid_helper_api_key"].arn]
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
resource "aws_iam_role_policy" "signups" {
  role   = aws_iam_role.signups.id
  policy = data.aws_iam_policy_document.signups.json
}
resource "aws_lambda_function" "signups" {
  function_name                  = "wow-forever-signups"
  role                           = aws_iam_role.signups.arn
  runtime                        = "nodejs22.x"
  handler                        = "index.handler"
  architectures                  = ["arm64"]
  filename                       = data.archive_file.signups.output_path
  source_code_hash               = data.archive_file.signups.output_base64sha256
  timeout                        = 300
  reserved_concurrent_executions = 1
  memory_size                    = 256
  environment {
    variables = {
      GUILD_ID    = var.guild_id
      GUILD_TABLE = aws_dynamodb_table.guild.name
    }
  }
  depends_on = [aws_cloudwatch_log_group.signups, aws_iam_role_policy.signups]
}
resource "aws_lambda_function_event_invoke_config" "signups" {
  function_name                = aws_lambda_function.signups.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 600
}
data "aws_iam_policy_document" "signups_scheduler_assume" {
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
resource "aws_iam_role" "signups_scheduler" {
  name               = "wow-forever-signups-scheduler"
  assume_role_policy = data.aws_iam_policy_document.signups_scheduler_assume.json
}
data "aws_iam_policy_document" "signups_scheduler" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.signups.arn]
  }
}
resource "aws_iam_role_policy" "signups_scheduler" {
  role   = aws_iam_role.signups_scheduler.id
  policy = data.aws_iam_policy_document.signups_scheduler.json
}
resource "aws_scheduler_schedule" "signups" {
  name                         = "wow-forever-signups"
  schedule_expression          = "rate(15 minutes)"
  schedule_expression_timezone = "America/New_York"
  flexible_time_window { mode = "OFF" }
  target {
    arn      = aws_lambda_function.signups.arn
    role_arn = aws_iam_role.signups_scheduler.arn
    input    = "{}"
    retry_policy {
      maximum_retry_attempts       = 0
      maximum_event_age_in_seconds = 600
    }
  }
  depends_on = [aws_iam_role_policy.signups_scheduler]
}
resource "aws_cloudwatch_metric_alarm" "signups_errors" {
  alarm_name          = "wow-forever-signups-errors"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  dimensions          = { FunctionName = aws_lambda_function.signups.function_name }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
