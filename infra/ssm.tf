resource "aws_ssm_parameter" "secrets" {
  for_each         = toset(["discord_bot_token", "discord_app_public_key", "alarm_webhook_url"])
  name             = "/wow-forever/${each.key}"
  type             = "SecureString"
  value_wo         = "None"
  value_wo_version = 1
}
data "aws_kms_key" "ssm" { key_id = "alias/aws/ssm" }

resource "aws_ssm_parameter" "external_api_keys" {
  for_each         = toset(["raid_helper_api_key", "guildsofwow_api_key", "parallel_api_key"])
  name             = "/wow-forever/${each.key}"
  type             = "SecureString"
  value_wo         = "None"
  value_wo_version = 1
  lifecycle {
    ignore_changes  = [value_wo, value_wo_version]
    prevent_destroy = true
  }
}
