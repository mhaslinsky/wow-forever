locals { mention_name = "wow-forever-assistant-mention" }

data "archive_file" "mention" {
  type        = "zip"
  source_dir  = "${path.module}/../build/mention"
  output_path = "${path.module}/.terraform/tmp/mention.zip"
}

resource "aws_iam_role" "mention" {
  name               = local.mention_name
  assume_role_policy = data.aws_iam_policy_document.interactions_assume.json
}

data "aws_iam_policy_document" "mention" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.mention.arn}:*"]
  }
  statement {
    actions = ["ssm:GetParameter"]
    resources = [
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
    actions   = ["dynamodb:GetItem"]
    resources = [aws_dynamodb_table.guild.arn]
  }
  statement {
    actions   = ["dynamodb:Query"]
    resources = ["${aws_dynamodb_table.guild.arn}/index/gsi1"]
  }
  statement {
    actions   = ["dynamodb:PutItem"]
    resources = [aws_dynamodb_table.claims.arn]
  }
}

resource "aws_iam_role_policy" "mention" {
  role   = aws_iam_role.mention.id
  policy = data.aws_iam_policy_document.mention.json
}

resource "aws_cloudwatch_log_group" "mention" {
  name              = "/aws/lambda/${local.mention_name}"
  retention_in_days = 14
}

resource "aws_lambda_function" "mention" {
  function_name    = local.mention_name
  role             = aws_iam_role.mention.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  architectures    = ["arm64"]
  filename         = data.archive_file.mention.output_path
  source_code_hash = data.archive_file.mention.output_base64sha256
  timeout          = 60
  memory_size      = 256
  environment {
    variables = {
      CLAIMS_TABLE      = aws_dynamodb_table.claims.name
      GUILD_TABLE       = aws_dynamodb_table.guild.name
      GUILD_ID          = var.guild_id
      GUARD_EXTRA_TERMS = var.guard_extra_terms
    }
  }
  depends_on = [aws_cloudwatch_log_group.mention, aws_iam_role_policy.mention]
}

resource "aws_lambda_function_event_invoke_config" "mention" {
  function_name                = aws_lambda_function.mention.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 600
}
