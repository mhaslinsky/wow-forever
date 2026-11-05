locals {
  interactions_name = "wow-forever-interactions"
}

data "archive_file" "interactions" {
  type        = "zip"
  source_dir  = "${path.module}/../build/interactions"
  output_path = "${path.module}/.terraform/tmp/interactions.zip"
}

resource "aws_dynamodb_table" "claims" {
  name                        = "wow-forever-claims"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "pk"
  deletion_protection_enabled = true
  attribute {
    name = "pk"
    type = "S"
  }
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
  point_in_time_recovery { enabled = true }
}

data "aws_iam_policy_document" "interactions_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "interactions" {
  name               = local.interactions_name
  assume_role_policy = data.aws_iam_policy_document.interactions_assume.json
}

data "aws_iam_policy_document" "interactions" {
  statement {
    actions   = ["dynamodb:Query", "dynamodb:DeleteItem", "dynamodb:PutItem", "dynamodb:ConditionCheckItem"]
    resources = [aws_dynamodb_table.guild.arn]
    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["FACT#*", "MEMORY_REPLY#*"]
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
    actions   = ["dynamodb:Query"]
    resources = ["${aws_dynamodb_table.guild.arn}/index/gsi1"]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.interactions.arn}:*"]
  }
  statement {
    actions = ["ssm:GetParameter"]
    resources = [
      aws_ssm_parameter.secrets["discord_app_public_key"].arn,
      aws_ssm_parameter.secrets["discord_bot_token"].arn,
      aws_ssm_parameter.external_api_keys["parallel_api_key"].arn,
    ]
  }
  statement {
    actions = ["bedrock:InvokeModel"]
    resources = [
      "arn:aws:bedrock:us-east-1:${var.aws_account_id}:inference-profile/us.anthropic.claude-sonnet-4-6",
      "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6",
      "arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-sonnet-4-6",
      "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-6",
    ]
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
    actions   = ["lambda:InvokeFunction"]
    resources = ["arn:aws:lambda:us-east-1:${var.aws_account_id}:function:${local.interactions_name}"]
  }
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.claims.arn]
  }
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:ConditionCheckItem"]
    resources = [aws_dynamodb_table.guild.arn]
  }
}

resource "aws_iam_role_policy" "interactions" {
  role   = aws_iam_role.interactions.id
  policy = data.aws_iam_policy_document.interactions.json
}

resource "aws_cloudwatch_log_group" "interactions" {
  name              = "/aws/lambda/${local.interactions_name}"
  retention_in_days = 14
}

resource "aws_lambda_function" "interactions" {
  function_name    = local.interactions_name
  role             = aws_iam_role.interactions.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  architectures    = ["arm64"]
  filename         = data.archive_file.interactions.output_path
  source_code_hash = data.archive_file.interactions.output_base64sha256
  timeout          = 60
  memory_size      = 256
  environment {
    variables = merge(local.assistant_spend_environment, {
      PUBLIC_KEY_PARAM      = aws_ssm_parameter.secrets["discord_app_public_key"].name
      CLAIMS_TABLE          = aws_dynamodb_table.claims.name
      GUILD_TABLE           = aws_dynamodb_table.guild.name
      GUILD_ID              = var.guild_id
      GUARD_EXTRA_TERMS     = var.guard_extra_terms
      WISHLIST_LOCK_MINUTES = tostring(var.wishlist_lock_minutes)
    })
  }
  depends_on = [aws_cloudwatch_log_group.interactions, aws_iam_role_policy.interactions]
}

resource "aws_lambda_function_event_invoke_config" "interactions" {
  function_name                = aws_lambda_function.interactions.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 600
}

resource "aws_lambda_function_url" "interactions" {
  function_name      = aws_lambda_function.interactions.function_name
  authorization_type = "NONE"
}

resource "aws_lambda_permission" "interactions_url" {
  statement_id           = "AllowPublicFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.interactions.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "interactions_url_invoke" {
  statement_id             = "AllowPublicInvokeViaUrl"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.interactions.function_name
  principal                = "*"
  invoked_via_function_url = true
}

output "interactions_url" {
  value = aws_lambda_function_url.interactions.function_url
}

resource "aws_cloudwatch_metric_alarm" "interactions_errors" {
  alarm_name          = "wow-forever-interactions-errors"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  dimensions = {
    FunctionName = aws_lambda_function.interactions.function_name
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
}

variable "wishlist_lock_minutes" {
  type    = number
  default = 60
  validation {
    condition     = var.wishlist_lock_minutes >= 0 && floor(var.wishlist_lock_minutes) == var.wishlist_lock_minutes
    error_message = "Wishlist lock minutes must be a nonnegative integer."
  }
}

variable "guard_extra_terms" {
  type      = string
  default   = ""
  sensitive = true
}
