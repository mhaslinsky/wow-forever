variable "guildos_guild_key" {
  type    = string
  default = null
}

locals { snapshot_ingest_name = "wow-forever-snapshot-ingest" }

data "archive_file" "snapshot_ingest" {
  type        = "zip"
  source_dir  = "${path.module}/../build/snapshot-ingest"
  output_path = "${path.module}/.terraform/tmp/snapshot-ingest.zip"
}

resource "aws_iam_role" "snapshot_ingest" {
  name               = local.snapshot_ingest_name
  assume_role_policy = data.aws_iam_policy_document.interactions_assume.json
}

data "aws_iam_policy_document" "snapshot_ingest" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.snapshot_ingest.arn}:*"]
  }
  statement {
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:us-east-1:${var.aws_account_id}:parameter/wow-forever/reader_token"]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [data.aws_kms_key.ssm.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.us-east-1.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:PARAMETER_ARN"
      values   = ["arn:aws:ssm:us-east-1:${var.aws_account_id}:parameter/wow-forever/reader_token"]
    }
  }
  statement {
    actions   = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:GetItem"]
    resources = [aws_dynamodb_table.guild.arn]
  }
}

resource "aws_iam_role_policy" "snapshot_ingest" {
  role   = aws_iam_role.snapshot_ingest.id
  policy = data.aws_iam_policy_document.snapshot_ingest.json
}

resource "aws_cloudwatch_log_group" "snapshot_ingest" {
  name              = "/aws/lambda/${local.snapshot_ingest_name}"
  retention_in_days = 14
}

resource "aws_lambda_function" "snapshot_ingest" {
  function_name                  = local.snapshot_ingest_name
  role                           = aws_iam_role.snapshot_ingest.arn
  runtime                        = "nodejs22.x"
  handler                        = "index.handler"
  architectures                  = ["arm64"]
  filename                       = data.archive_file.snapshot_ingest.output_path
  source_code_hash               = data.archive_file.snapshot_ingest.output_base64sha256
  timeout                        = 30
  memory_size                    = 256
  reserved_concurrent_executions = 2
  environment {
    variables = merge({ GUILD_TABLE = aws_dynamodb_table.guild.name },
    var.guildos_guild_key == null ? {} : { GUILDOS_GUILD_KEY = var.guildos_guild_key })
  }
  depends_on = [aws_cloudwatch_log_group.snapshot_ingest, aws_iam_role_policy.snapshot_ingest]
}

resource "aws_lambda_function_url" "snapshot_ingest" {
  function_name      = aws_lambda_function.snapshot_ingest.function_name
  authorization_type = "NONE"
}

resource "aws_lambda_permission" "snapshot_ingest_url" {
  statement_id           = "AllowPublicFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.snapshot_ingest.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "snapshot_ingest_url_invoke" {
  statement_id             = "AllowPublicInvokeViaUrl"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.snapshot_ingest.function_name
  principal                = "*"
  invoked_via_function_url = true
}

resource "aws_cloudwatch_metric_alarm" "snapshot_ingest_errors" {
  alarm_name          = "wow-forever-snapshot-ingest-errors"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  dimensions = {
    FunctionName = aws_lambda_function.snapshot_ingest.function_name
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
}

output "snapshot_ingest_url" {
  value = aws_lambda_function_url.snapshot_ingest.function_url
}
