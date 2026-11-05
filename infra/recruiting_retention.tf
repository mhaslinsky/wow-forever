variable "recruiting_retention_days" {
  type    = number
  default = 90
  validation {
    condition     = var.recruiting_retention_days > 0 && floor(var.recruiting_retention_days) == var.recruiting_retention_days
    error_message = "Retention days must be a positive integer."
  }
}
variable "recruiting_retention_schedule" {
  type    = string
  default = "cron(0 4 * * ? *)"
}

data "archive_file" "recruiting_retention" {
  type        = "zip"
  source_dir  = "${path.module}/../build/recruiting-retention"
  output_path = "${path.module}/.terraform/tmp/recruiting-retention.zip"
}
resource "aws_cloudwatch_log_group" "recruiting_retention" {
  name              = "/aws/lambda/wow-forever-recruiting-retention"
  retention_in_days = 14
}
resource "aws_iam_role" "recruiting_retention" {
  name               = "wow-forever-recruiting-retention"
  assume_role_policy = data.aws_iam_policy_document.interactions_assume.json
}
data "aws_iam_policy_document" "recruiting_retention" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.recruiting_retention.arn}:*"]
  }
  statement {
    actions   = ["dynamodb:Query"]
    resources = [aws_dynamodb_table.guild.arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["CANDIDATE#${var.guild_id}", "OFFICER_NOTE#${var.guild_id}", "RECRUITING_INTAKE#${var.guild_id}"]
    }
  }
  statement {
    actions   = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"]
    resources = [aws_dynamodb_table.guild.arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["CANDIDATE#${var.guild_id}"]
    }
  }
  statement {
    actions   = ["dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.guild.arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["OFFICER_NOTE#${var.guild_id}", "RECRUITING_INTAKE#${var.guild_id}"]
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
resource "aws_iam_role_policy" "recruiting_retention" {
  role   = aws_iam_role.recruiting_retention.id
  policy = data.aws_iam_policy_document.recruiting_retention.json
}
resource "aws_lambda_function" "recruiting_retention" {
  function_name    = "wow-forever-recruiting-retention"
  role             = aws_iam_role.recruiting_retention.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  architectures    = ["arm64"]
  filename         = data.archive_file.recruiting_retention.output_path
  source_code_hash = data.archive_file.recruiting_retention.output_base64sha256
  timeout          = 60
  memory_size      = 256
  environment {
    variables = {
      RETENTION_DAYS = tostring(var.recruiting_retention_days)
      GUILD_ID       = var.guild_id
      GUILD_TABLE    = aws_dynamodb_table.guild.name
    }
  }
  depends_on = [aws_cloudwatch_log_group.recruiting_retention, aws_iam_role_policy.recruiting_retention]
}
resource "aws_lambda_function_event_invoke_config" "recruiting_retention" {
  function_name                = aws_lambda_function.recruiting_retention.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 600
}
data "aws_iam_policy_document" "recruiting_retention_scheduler_assume" {
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
resource "aws_iam_role" "recruiting_retention_scheduler" {
  name               = "wow-forever-recruiting-retention-scheduler"
  assume_role_policy = data.aws_iam_policy_document.recruiting_retention_scheduler_assume.json
}
data "aws_iam_policy_document" "recruiting_retention_scheduler" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.recruiting_retention.arn]
  }
}
resource "aws_iam_role_policy" "recruiting_retention_scheduler" {
  role   = aws_iam_role.recruiting_retention_scheduler.id
  policy = data.aws_iam_policy_document.recruiting_retention_scheduler.json
}
resource "aws_scheduler_schedule" "recruiting_retention" {
  name                         = "wow-forever-recruiting-retention"
  schedule_expression          = var.recruiting_retention_schedule
  schedule_expression_timezone = "America/New_York"
  flexible_time_window { mode = "OFF" }
  target {
    arn      = aws_lambda_function.recruiting_retention.arn
    role_arn = aws_iam_role.recruiting_retention_scheduler.arn
    input    = "{}"
    retry_policy {
      maximum_retry_attempts       = 0
      maximum_event_age_in_seconds = 600
    }
  }
  depends_on = [aws_iam_role_policy.recruiting_retention_scheduler]
}
resource "aws_cloudwatch_metric_alarm" "recruiting_retention_errors" {
  alarm_name          = "wow-forever-recruiting-retention-errors"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  dimensions          = { FunctionName = aws_lambda_function.recruiting_retention.function_name }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
