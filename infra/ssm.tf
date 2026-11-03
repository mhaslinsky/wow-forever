resource "aws_ssm_parameter" "secrets" {
  for_each = toset(["discord_bot_token", "discord_app_public_key", "alarm_webhook_url"])
  name     = "/wow-forever/${each.key}"
  type     = "SecureString"
  value    = "None"
  lifecycle { ignore_changes = [value] }
}
data "aws_kms_key" "ssm" { key_id = "alias/aws/ssm" }
