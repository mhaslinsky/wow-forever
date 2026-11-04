data "archive_file" "gow_intake" {
  type        = "zip"
  source_dir  = "${path.module}/../build/gow-intake"
  output_path = "${path.module}/.terraform/tmp/gow-intake.zip"
}
resource "aws_cloudwatch_log_group" "gow_intake" {
  name              = "/aws/lambda/wow-forever-gow-intake"
  retention_in_days = 14
}
resource "aws_iam_role" "gow_intake" {
  name               = "wow-forever-gow-intake"
  assume_role_policy = data.aws_iam_policy_document.interactions_assume.json
}
data "aws_iam_policy_document" "gow_intake" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.gow_intake.arn}:*"]
  }
  statement {
    actions   = ["dynamodb:PutItem"]
    resources = [aws_dynamodb_table.guild.arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["GOW_APPLICATION#${var.guild_id}"]
    }
  }
  statement {
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.secrets["guildsofwow_api_key"].arn]
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
resource "aws_iam_role_policy" "gow_intake" {
  role   = aws_iam_role.gow_intake.id
  policy = data.aws_iam_policy_document.gow_intake.json
}
resource "aws_lambda_function" "gow_intake" {
  function_name                  = "wow-forever-gow-intake"
  role                           = aws_iam_role.gow_intake.arn
  runtime                        = "nodejs22.x"
  handler                        = "index.handler"
  architectures                  = ["arm64"]
  filename                       = data.archive_file.gow_intake.output_path
  source_code_hash               = data.archive_file.gow_intake.output_base64sha256
  timeout                        = 300
  reserved_concurrent_executions = 1
  memory_size                    = 256
  environment {
    variables = {
      GUILD_ID    = var.guild_id
      GUILD_TABLE = aws_dynamodb_table.guild.name
    }
  }
  depends_on = [aws_cloudwatch_log_group.gow_intake, aws_iam_role_policy.gow_intake]
}
resource "aws_lambda_function_event_invoke_config" "gow_intake" {
  function_name                = aws_lambda_function.gow_intake.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 600
}
data "aws_iam_policy_document" "gow_intake_scheduler_assume" {
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
resource "aws_iam_role" "gow_intake_scheduler" {
  name               = "wow-forever-gow-intake-scheduler"
  assume_role_policy = data.aws_iam_policy_document.gow_intake_scheduler_assume.json
}
data "aws_iam_policy_document" "gow_intake_scheduler" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.gow_intake.arn]
  }
}
resource "aws_iam_role_policy" "gow_intake_scheduler" {
  role   = aws_iam_role.gow_intake_scheduler.id
  policy = data.aws_iam_policy_document.gow_intake_scheduler.json
}
resource "aws_scheduler_schedule" "gow_intake" {
  name                         = "wow-forever-gow-intake"
  schedule_expression          = "rate(15 minutes)"
  schedule_expression_timezone = "America/New_York"
  flexible_time_window { mode = "OFF" }
  target {
    arn      = aws_lambda_function.gow_intake.arn
    role_arn = aws_iam_role.gow_intake_scheduler.arn
    input    = "{}"
    retry_policy {
      maximum_retry_attempts       = 0
      maximum_event_age_in_seconds = 600
    }
  }
  depends_on = [aws_iam_role_policy.gow_intake_scheduler]
}
resource "aws_cloudwatch_metric_alarm" "gow_intake_errors" {
  alarm_name          = "wow-forever-gow-intake-errors"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  dimensions          = { FunctionName = aws_lambda_function.gow_intake.function_name }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
