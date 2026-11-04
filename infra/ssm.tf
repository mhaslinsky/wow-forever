resource "aws_ssm_parameter" "secrets" {
  for_each         = toset(["discord_bot_token", "discord_app_public_key", "alarm_webhook_url"])
  name             = "/wow-forever/${each.key}"
  type             = "SecureString"
  value_wo         = "None"
  value_wo_version = 1
}
data "aws_kms_key" "ssm" { key_id = "alias/aws/ssm" }

locals {
  external_api_key_names = toset(["raid_helper_api_key", "guildsofwow_api_key", "parallel_api_key"])
}

import {
  for_each = local.external_api_key_names
  to       = aws_ssm_parameter.external_api_keys[each.key]
  id       = "/wow-forever/${each.key}"
}

resource "aws_ssm_parameter" "external_api_keys" {
  for_each         = local.external_api_key_names
  name             = "/wow-forever/${each.key}"
  type             = "SecureString"
  value_wo         = "None"
  value_wo_version = 1
  lifecycle {
    ignore_changes  = all
    prevent_destroy = true
  }
}
