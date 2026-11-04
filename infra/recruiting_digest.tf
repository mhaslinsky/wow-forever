variable "guild_id" {
  type      = string
  sensitive = true
  validation {
    condition     = can(regex("^[0-9]+$", var.guild_id))
    error_message = "Guild ID must be a Discord snowflake."
  }
}
variable "recruiting_digest_schedule" {
  type    = string
  default = "cron(0 10 * * ? *)"
}

data "archive_file" "recruiting_digest" {
  type        = "zip"
  source_dir  = "${path.module}/../build/recruiting-digest"
  output_path = "${path.module}/.terraform/tmp/recruiting-digest.zip"
}
resource "aws_cloudwatch_log_group" "recruiting_digest" {
  name              = "/aws/lambda/wow-forever-recruiting-digest"
  retention_in_days = 14
}
resource "aws_iam_role" "recruiting_digest" {
  name               = "wow-forever-recruiting-digest"
  assume_role_policy = data.aws_iam_policy_document.interactions_assume.json
}
data "aws_iam_policy_document" "recruiting_digest" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.recruiting_digest.arn}:*"]
  }
  statement {
    actions   = ["dynamodb:Query"]
    resources = [aws_dynamodb_table.guild.arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["CANDIDATE#${var.guild_id}"]
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
resource "aws_iam_role_policy" "recruiting_digest" {
  role   = aws_iam_role.recruiting_digest.id
  policy = data.aws_iam_policy_document.recruiting_digest.json
}
resource "aws_lambda_function" "recruiting_digest" {
  function_name    = "wow-forever-recruiting-digest"
  role             = aws_iam_role.recruiting_digest.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  architectures    = ["arm64"]
  filename         = data.archive_file.recruiting_digest.output_path
  source_code_hash = data.archive_file.recruiting_digest.output_base64sha256
  timeout          = 60
  memory_size      = 256
  environment {
    variables = {
      GUILD_ID    = var.guild_id
      GUILD_TABLE = aws_dynamodb_table.guild.name
    }
  }
  depends_on = [aws_cloudwatch_log_group.recruiting_digest, aws_iam_role_policy.recruiting_digest]
}
resource "aws_lambda_function_event_invoke_config" "recruiting_digest" {
  function_name                = aws_lambda_function.recruiting_digest.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 600
}
data "aws_iam_policy_document" "recruiting_digest_scheduler_assume" {
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
resource "aws_iam_role" "recruiting_digest_scheduler" {
  name               = "wow-forever-recruiting-digest-scheduler"
  assume_role_policy = data.aws_iam_policy_document.recruiting_digest_scheduler_assume.json
}
data "aws_iam_policy_document" "recruiting_digest_scheduler" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.recruiting_digest.arn]
  }
}
resource "aws_iam_role_policy" "recruiting_digest_scheduler" {
  role   = aws_iam_role.recruiting_digest_scheduler.id
  policy = data.aws_iam_policy_document.recruiting_digest_scheduler.json
}
resource "aws_scheduler_schedule" "recruiting_digest" {
  name                         = "wow-forever-recruiting-digest"
  schedule_expression          = var.recruiting_digest_schedule
  schedule_expression_timezone = "America/New_York"
  flexible_time_window { mode = "OFF" }
  target {
    arn      = aws_lambda_function.recruiting_digest.arn
    role_arn = aws_iam_role.recruiting_digest_scheduler.arn
    input    = "{}"
    retry_policy {
      maximum_retry_attempts       = 0
      maximum_event_age_in_seconds = 600
    }
  }
  depends_on = [aws_iam_role_policy.recruiting_digest_scheduler]
}
resource "aws_cloudwatch_metric_alarm" "recruiting_digest_errors" {
  alarm_name          = "wow-forever-recruiting-digest-errors"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  dimensions          = { FunctionName = aws_lambda_function.recruiting_digest.function_name }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
