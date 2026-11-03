# SNS HTTPS envelopes and subscription confirmation are incompatible with Discord.

locals {
  alarm_forwarder_name = "wow-forever-alarm-forwarder"
}

data "archive_file" "alarm_forwarder" {
  type        = "zip"
  source_dir  = "${path.module}/../build/alarm-forwarder"
  output_path = "${path.module}/.terraform/tmp/alarm-forwarder.zip"
}

data "aws_iam_policy_document" "alarm_forwarder_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "alarm_forwarder" {
  name               = local.alarm_forwarder_name
  assume_role_policy = data.aws_iam_policy_document.alarm_forwarder_assume.json
}

resource "aws_iam_role_policy_attachment" "alarm_forwarder_logs" {
  role       = aws_iam_role.alarm_forwarder.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "alarm_forwarder" {
  statement {
    sid       = "ReadWebhook"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.secrets["alarm_webhook_url"].arn]
  }

  statement {
    sid       = "DecryptSecureString"
    actions   = ["kms:Decrypt"]
    resources = [data.aws_kms_key.ssm.arn]
  }
}

resource "aws_iam_role_policy" "alarm_forwarder" {
  name   = local.alarm_forwarder_name
  role   = aws_iam_role.alarm_forwarder.id
  policy = data.aws_iam_policy_document.alarm_forwarder.json
}

resource "aws_cloudwatch_log_group" "alarm_forwarder" {
  name              = "/aws/lambda/${local.alarm_forwarder_name}"
  retention_in_days = 14
}

resource "aws_lambda_function" "alarm_forwarder" {
  function_name = local.alarm_forwarder_name
  role          = aws_iam_role.alarm_forwarder.arn
  runtime       = "nodejs22.x"
  handler       = "index.handler"
  architectures = ["arm64"]

  filename         = data.archive_file.alarm_forwarder.output_path
  source_code_hash = data.archive_file.alarm_forwarder.output_base64sha256

  timeout     = 30
  memory_size = 128

  environment {
    variables = {
      ALARM_WEBHOOK_PARAM = aws_ssm_parameter.secrets["alarm_webhook_url"].name
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.alarm_forwarder,
    aws_iam_role_policy.alarm_forwarder,
    aws_iam_role_policy_attachment.alarm_forwarder_logs,
  ]
}

resource "aws_sns_topic_subscription" "alerts_discord" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.alarm_forwarder.arn

  depends_on = [aws_lambda_permission.alarm_forwarder_sns]
}

resource "aws_lambda_permission" "alarm_forwarder_sns" {
  statement_id  = "AllowExecutionFromSNS"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.alarm_forwarder.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.alerts.arn
}


