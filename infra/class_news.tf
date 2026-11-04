data "archive_file" "class_news" {
  type        = "zip"
  source_dir  = "${path.module}/../build/class-news"
  output_path = "${path.module}/.terraform/tmp/class-news.zip"
}
resource "aws_cloudwatch_log_group" "class_news" {
  name              = "/aws/lambda/wow-forever-class-news"
  retention_in_days = 14
}
resource "aws_iam_role" "class_news" {
  name               = "wow-forever-class-news"
  assume_role_policy = data.aws_iam_policy_document.interactions_assume.json
}
data "aws_iam_policy_document" "class_news" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.class_news.arn}:*"]
  }
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.guild.arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["CLASS_NEWS#${var.guild_id}"]
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
resource "aws_iam_role_policy" "class_news" {
  role   = aws_iam_role.class_news.id
  policy = data.aws_iam_policy_document.class_news.json
}
resource "aws_lambda_function" "class_news" {
  function_name                  = "wow-forever-class-news"
  role                           = aws_iam_role.class_news.arn
  runtime                        = "nodejs22.x"
  handler                        = "index.handler"
  architectures                  = ["arm64"]
  filename                       = data.archive_file.class_news.output_path
  source_code_hash               = data.archive_file.class_news.output_base64sha256
  timeout                        = 300
  reserved_concurrent_executions = 1
  memory_size                    = 256
  environment {
    variables = {
      GUILD_ID    = var.guild_id
      GUILD_TABLE = aws_dynamodb_table.guild.name
    }
  }
  depends_on = [aws_cloudwatch_log_group.class_news, aws_iam_role_policy.class_news]
}
resource "aws_lambda_function_event_invoke_config" "class_news" {
  function_name                = aws_lambda_function.class_news.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 600
}
data "aws_iam_policy_document" "class_news_scheduler_assume" {
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
resource "aws_iam_role" "class_news_scheduler" {
  name               = "wow-forever-class-news-scheduler"
  assume_role_policy = data.aws_iam_policy_document.class_news_scheduler_assume.json
}
data "aws_iam_policy_document" "class_news_scheduler" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.class_news.arn]
  }
}
resource "aws_iam_role_policy" "class_news_scheduler" {
  role   = aws_iam_role.class_news_scheduler.id
  policy = data.aws_iam_policy_document.class_news_scheduler.json
}
resource "aws_scheduler_schedule" "class_news" {
  name                         = "wow-forever-class-news"
  schedule_expression          = "rate(30 minutes)"
  schedule_expression_timezone = "America/New_York"
  flexible_time_window { mode = "OFF" }
  target {
    arn      = aws_lambda_function.class_news.arn
    role_arn = aws_iam_role.class_news_scheduler.arn
    input    = "{}"
    retry_policy {
      maximum_retry_attempts       = 0
      maximum_event_age_in_seconds = 600
    }
  }
  depends_on = [aws_iam_role_policy.class_news_scheduler]
}
resource "aws_cloudwatch_metric_alarm" "class_news_errors" {
  alarm_name          = "wow-forever-class-news-errors"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  dimensions          = { FunctionName = aws_lambda_function.class_news.function_name }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
